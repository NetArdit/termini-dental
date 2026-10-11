import { ConfigError, readConfig } from "./config";
import type { Ctx } from "./context";
import { openPostgres } from "./db";
import { DatabaseRateLimiter } from "./limits";
import { createLogger, safeError } from "./log";
import { smtpMailer } from "./mail";

// What main.ts does for a server that stays up, done for code that a host starts on demand and may run as
// several copies at once (a serverless function). The differences, all deliberate:
//   - A database server is required. The built-in database is one folder for one process; a function has neither.
//   - Migrations are NOT applied here. They are a step of their own before a release (npm run db:migrate):
//     a function starts many times a day, several at once, and must never be what changes the schema.
//   - Very few connections per copy: there can be many copies and the database has a limit for all of them.
//   - The limits on logins and bookings are counted in the database, never in the memory of one copy.
//   - The visitor's address is taken from the header the host's edge sets itself (see CLIENT_ADDRESS_HEADER).

/**
 * Netlify puts the address of the connection it accepted into this header and overwrites whatever the
 * visitor sent under the same name. X-Forwarded-For is not used at all: a visitor can put anything there.
 */
export const CLIENT_ADDRESS_HEADER = "x-nf-client-connection-ip";

/** DATABASE_URL is not set. A function cannot use the built-in database. */
export class MissingDatabase extends Error {}

let ready: Promise<Ctx> | undefined;

async function open(env: Record<string, string | undefined>): Promise<Ctx> {
  const { config, warnings } = readConfig(env);
  if (!config.databaseUrl) throw new MissingDatabase();
  const log = createLogger({ level: config.logLevel });
  // TRUST_PROXY decides how Express reads X-Forwarded-For, which is not consulted here.
  for (const warning of warnings.filter((w) => !w.startsWith("TRUST_PROXY"))) log.warn("configuration", { warning });
  const db = await openPostgres(config.databaseUrl, { migrate: false, maxConnections: 2, idleMs: 5_000 });
  return {
    db,
    now: () => new Date(),
    mailer: config.smtp ? await smtpMailer(config.smtp) : null,
    publicUrl: config.publicUrl,
    log,
    limiter: new DatabaseRateLimiter(db, config.limiterSecret),
    clientAddress: (req) => req.get(CLIENT_ADDRESS_HEADER),
    // The pages are published by the host itself; the function answers the API only.
    webDir: "/nowhere",
  };
}

/** Opened once per copy of the function and kept for the requests that copy serves. */
export function serverlessContext(env: Record<string, string | undefined> = process.env): Promise<Ctx> {
  ready ??= open(env).catch((err: unknown) => {
    // Not kept: the next request tries again instead of failing for as long as this copy lives.
    ready = undefined;
    throw err;
  });
  return ready;
}

/**
 * What may be said in the log about a failure to start. Never the error's text: a database driver quotes the
 * connection string in some of its messages. A configuration problem is the exception, it is written by
 * config.ts and names settings, not secrets.
 */
export function startFailure(err: unknown): Record<string, unknown> {
  if (err instanceof ConfigError) return { errorType: "ConfigError", problems: err.problems };
  if (err instanceof MissingDatabase) return { errorType: "MissingDatabase" };
  return safeError(err);
}
