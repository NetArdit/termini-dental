import { createHash } from "node:crypto";
import { parseLevel, type Level } from "./log";

// Everything the server takes from its environment, read once, checked at start. A setting that is wrong
// stops the server with a sentence that says what to change; one that is merely risky is reported as a
// warning and the server runs. Secrets are never echoed: the summary says only whether they are set.

export interface Config {
  production: boolean;
  port: number;
  /** PostgreSQL connection string, or null for the built-in database in `pgliteDir`. */
  databaseUrl: string | null;
  pgliteDir: string;
  /** Public address of the site, no trailing slash. Goes into the links of patient emails. */
  publicUrl: string;
  trustProxy: boolean;
  logLevel: Level;
  smtp: { host: string; port: number; user: string | null; pass: string | null; from: string } | null;
  /**
   * Key for the hashes under which rate-limit counters are stored, so that the table holds no email or
   * network address. RATE_LIMIT_SECRET when set; otherwise derived from the database address, which only
   * the application knows. Never logged.
   */
  limiterSecret: string;
}

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Configuration is not usable:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

type Env = Record<string, string | undefined>;
const text = (value: string | undefined) => (value === undefined || value.trim() === "" ? null : value.trim());

export function readConfig(env: Env): { config: Config; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === "production";

  const port = Number(text(env.PORT) ?? 3101);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT must be a number between 1 and 65535 (it is "${env.PORT}").`);

  const databaseUrl = text(env.DATABASE_URL);
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push("DATABASE_URL must start with postgres:// or postgresql://.");

  let publicUrl = (text(env.PUBLIC_URL) ?? "http://localhost:5180").replace(/\/+$/, "");
  try {
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http");
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) problems.push("PUBLIC_URL must be the address of the site only, like https://termine.example.com, without a path.");
    if (production && parsed.protocol !== "https:") warnings.push("PUBLIC_URL is not https. Patients' private links and the staff login would travel unencrypted.");
    if (production && /^(localhost|127\.|\[::1\])/.test(parsed.hostname)) warnings.push("PUBLIC_URL points at this machine. The links in patient emails will not work for patients.");
    publicUrl = parsed.origin;
  } catch {
    problems.push(`PUBLIC_URL must be a full address like https://termine.example.com (it is "${publicUrl}").`);
  }

  let smtp: Config["smtp"] = null;
  const host = text(env.SMTP_HOST);
  if (host) {
    const smtpPort = Number(text(env.SMTP_PORT) ?? 587);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) problems.push(`SMTP_PORT must be a port number (it is "${env.SMTP_PORT}").`);
    const from = text(env.MAIL_FROM);
    if (!from) problems.push("SMTP_HOST is set, so MAIL_FROM must be set too: the address patients see as the sender.");
    else if (!/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(from)) problems.push("MAIL_FROM must contain an email address, like  Klinika Dentare <termine@example.com>.");
    else if (/@example\.(com|org|net)\b/.test(from)) problems.push("MAIL_FROM still uses the example address. Mail servers reject it; use the sender verified with your mail provider.");
    const user = text(env.SMTP_USER);
    const pass = text(env.SMTP_PASS);
    if (Boolean(user) !== Boolean(pass)) problems.push("SMTP_USER and SMTP_PASS go together: set both or neither.");
    smtp = { host, port: smtpPort, user, pass, from: from ?? "" };
  } else {
    for (const name of ["SMTP_USER", "SMTP_PASS"]) if (text(env[name])) warnings.push(`${name} is set but SMTP_HOST is not, so no email is sent.`);
    warnings.push("No mail server is configured (SMTP_HOST). Patients receive no email: cancellations must be phoned through. Messages are kept in the outbox.");
  }

  if (production && !databaseUrl) {
    warnings.push("NODE_ENV is production but DATABASE_URL is not set, so the built-in single-file database is used. It allows one server process only and its backups are yours to arrange (npm run db:backup).");
  }
  // A yes-or-no setting is read as one: "false" or "0" must never switch it ON because it is not empty.
  const proxy = text(env.TRUST_PROXY)?.toLowerCase() ?? "";
  const trustProxy = ["1", "true", "yes"].includes(proxy);
  if (!trustProxy && !["", "0", "false", "no"].includes(proxy)) problems.push(`TRUST_PROXY must be 1 (or true) to trust the host's proxy, or 0 (or false, or empty) not to (it is "${env.TRUST_PROXY}").`);
  if (production && !trustProxy) warnings.push("TRUST_PROXY is not set. Behind a hosting proxy every visitor then appears to come from one address, and the limits on logins and bookings count them together.");

  const level = text(env.LOG_LEVEL);
  if (level && parseLevel(level) !== level) problems.push(`LOG_LEVEL must be debug, info, warn or error (it is "${level}").`);

  if (problems.length) throw new ConfigError(problems);
  return {
    config: {
      production,
      port,
      databaseUrl,
      pgliteDir: text(env.PGLITE_DIR) ?? "data/pg",
      publicUrl,
      trustProxy,
      logLevel: parseLevel(level ?? undefined),
      smtp,
      limiterSecret: createHash("sha256").update(`termini-rate-limits|${text(env.RATE_LIMIT_SECRET) ?? databaseUrl ?? "built-in"}`).digest("hex"),
    },
    warnings,
  };
}

/** The configuration as it is fit to print: where a secret would be, only whether there is one. */
export function describeConfig(config: Config): Record<string, unknown> {
  let database = `built-in (${config.pgliteDir})`;
  if (config.databaseUrl) {
    try {
      const u = new URL(config.databaseUrl);
      // Host and database name help to see which server this is; user and password stay out.
      database = `postgres at ${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
    } catch {
      database = "postgres (address not shown)";
    }
  }
  return {
    production: config.production,
    port: config.port,
    database,
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    logLevel: config.logLevel,
    mail: config.smtp ? { host: config.smtp.host, port: config.smtp.port, login: config.smtp.user ? "set" : "none", sender: "set" } : "not configured",
  };
}
