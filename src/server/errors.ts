import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { safeError, type Logger } from "./log";

/** An error meant for the person using the app. `message` is shown as-is, so it is written in Albanian. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Validates request input; a failure becomes a 400 with one message per field. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    if (!fields[key]) fields[key] = issue.message;
  }
  throw new HttpError(400, "Ju lutemi kontrolloni fushat e shënuara.", fields);
}

/** A positive integer taken from the URL, or a 404: an id that is not a number names nothing. */
export function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "Nuk u gjet.");
  return n;
}

/** Turns whatever a route threw into an answer. Only the unexpected is logged, and only its kind (see log.ts). */
export const errorHandler =
  (log: Logger) =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, fields: err.fields });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Të dhëna të pavlefshme." });
    return;
  }
  if (typeof err === "object" && err !== null && "type" in err && (err as { type: unknown }).type === "entity.parse.failed") {
    res.status(400).json({ error: "Kërkesë e pavlefshme." });
    return;
  }
  // More than this address accepts. It used to be answered as an unexplained failure (500); it is the
  // sender's request that is too large, and saying so tells them what to change.
  if (typeof err === "object" && err !== null && "type" in err && (err as { type: unknown }).type === "entity.too.large") {
    res.status(413).json({ error: "Kërkesa është shumë e madhe." });
    return;
  }
  log.error("unexpected_error", { requestId: req.requestId, method: req.method, ...safeError(err) });
  // The id lets the clinic quote something that leads straight to the log line, without quoting data.
  res.status(500).json({ error: "Diçka shkoi keq. Ju lutemi provoni përsëri.", requestId: req.requestId });
  };
