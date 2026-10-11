import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Logs: one JSON object per line, so a host's log viewer can filter them and a person can still read them.
//
// What never goes into a log, by construction rather than by care:
//   - No request bodies, no query strings, no response bodies.
//   - No raw paths. A path can hold a patient's private link (/api/public/appointments/<token>) or a
//     search for a name. Requests are logged by their route pattern, e.g. "/api/public/appointments/:token".
//   - No names, phone numbers, email addresses, report texts, passwords, keys or connection strings.
//     Records are referred to by their numeric id only.
//   - No free text from the database or the mail server (their messages can quote a row or an address).
//     An error is logged by its class and code; its message only when this application wrote it.
// Callers pass plain fields; `safeError` is the one place that decides what of an error is fit to print.

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(options: { level?: Level; write?: (line: string, level: Level) => void; now?: () => Date } = {}): Logger {
  const threshold = ORDER[options.level ?? "info"];
  const write = options.write ?? ((line, level) => (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n"));
  const now = options.now ?? (() => new Date());
  const emit = (level: Level) => (event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < threshold) return;
    write(JSON.stringify({ time: now().toISOString(), level, event, ...fields }), level);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** A logger that says nothing: the default in tests. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function parseLevel(value: string | undefined): Level {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

/**
 * What may be printed about an error. PostgreSQL and SMTP errors carry data in their text (a duplicate key
 * quotes the value, a refused recipient quotes the address), so for anything that did not originate in this
 * code only the kind of error is kept: its class, its code, and where in our code it surfaced.
 */
export function safeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { errorType: typeof err };
  const code = "code" in err && (typeof err.code === "string" || typeof err.code === "number") ? err.code : undefined;
  const ours = (err.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    // Only frames in this application's own files; paths are cut to the part inside the project.
    .filter((line) => /[\\/]src[\\/]server[\\/]/.test(line))
    .map((line) => line.replace(/^at\s+/, "").replace(/\(?[^()\s]*[\\/]src[\\/]server[\\/]/, "(src/server/"))
    .slice(0, 5);
  return { errorType: err.constructor.name, ...(code === undefined ? {} : { errorCode: code }), ...(ours.length ? { at: ours } : {}) };
}

declare module "express-serve-static-core" {
  interface Request {
    /** Short id of this request, also sent back as X-Request-Id, so a report can be matched to a log line. */
    requestId?: string;
  }
}

/**
 * Logs every API request when it finishes: what kind, how it ended, how long it took, and who asked.
 * The kind is the route as it was declared ("/api/patients/:id"), never the address as it was typed.
 */
export function requestLog(log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    req.requestId = randomUUID().slice(0, 8);
    res.setHeader("X-Request-Id", req.requestId);
    // The framework notes the matched route on the request and takes the note away again when the route
    // fails. A failed request is the one most worth identifying, so the pattern is kept the moment it is set.
    let matched: string | undefined;
    let current: unknown;
    Object.defineProperty(req, "route", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (route: unknown) => {
        current = route;
        const declared = (route as { path?: unknown } | undefined)?.path;
        if (typeof declared === "string") matched = `${req.baseUrl}${declared}`;
      },
    });
    res.on("finish", () => {
      // No route matched: say which kind of thing was asked for, not which address.
      const route = matched ?? (req.originalUrl.startsWith("/api/") ? "/api/(unmatched)" : req.originalUrl.startsWith("/assets/") ? "/assets/*" : "(page)");
      // The page and its assets are noise; the API is what tells you how the clinic's day is going.
      if (!route.startsWith("/api")) return;
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      const fields = { requestId: req.requestId, method: req.method, route, status: res.statusCode, ms, userId: req.user?.id, clinicId: req.user?.clinicId };
      if (res.statusCode >= 500) log.error("request", fields);
      else log.info("request", fields);
    });
    next();
  };
}
