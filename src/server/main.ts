import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { ConfigError, describeConfig, readConfig } from "./config";
import type { Ctx } from "./context";
import { MigrationError, openPostgres, schemaVersion, type Db } from "./db";
import { openPglite } from "./db-local";
import { DatabaseRateLimiter, MemoryRateLimiter } from "./limits";
import { createLogger, safeError } from "./log";
import { smtpMailer } from "./mail";
import { startReminderLoop } from "./reminders";

try {
  process.loadEnvFile();
} catch {
  // No .env file: defaults apply.
}

// Before anything is opened: is the configuration usable at all?
let settings;
try {
  settings = readConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const { config, warnings } = settings;
const log = createLogger({ level: config.logLevel });
log.info("starting", describeConfig(config));
for (const warning of warnings) log.warn("configuration", { warning });

/**
 * The built-in database is one folder used by one process. A second server on the same folder (a forgotten
 * terminal, a second deploy) can damage it, so the folder carries a note of who has it open.
 */
function claimFolder(dir: string): () => void {
  const lock = path.join(dir, "termini.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    let alive = false;
    try {
      // Signal 0 sends nothing: it only asks whether that process exists.
      if (Number.isInteger(pid) && pid > 0) alive = process.kill(pid, 0);
    } catch (err) {
      // EPERM: it exists and belongs to someone else. ESRCH: it is gone.
      alive = (err as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive && pid !== process.pid) {
      console.error(`The database folder ${dir} is in use by another running server (process ${pid}). Two servers on one folder can corrupt it. Stop that one first, or give this one its own PGLITE_DIR.`);
      process.exit(1);
    }
    // Left behind by a process that is gone (a crash, a power cut): safe to take over.
    rmSync(lock, { force: true });
  }
  const handle = openSync(lock, "wx");
  writeSync(handle, String(process.pid));
  closeSync(handle);
  return () => rmSync(lock, { force: true });
}

let db: Db;
let releaseFolder = () => {};
try {
  if (config.databaseUrl) {
    db = await openPostgres(config.databaseUrl);
  } else {
    const dir = path.resolve(config.pgliteDir);
    mkdirSync(dir, { recursive: true });
    releaseFolder = claimFolder(dir);
    db = await openPglite(dir);
  }
} catch (err) {
  releaseFolder();
  if (err instanceof MigrationError) {
    console.error(err.message);
    process.exit(1);
  }
  log.error("database_unavailable", safeError(err));
  console.error("The database could not be opened. Check DATABASE_URL (or PGLITE_DIR) and that the database server is running.");
  process.exit(1);
}
log.info("database_ready", { schemaVersion: await schemaVersion(db) });

const mailer = config.smtp ? await smtpMailer(config.smtp) : null;
// With a database server the counters live in it, shared by however many instances there are. With the
// built-in database there is exactly one process (the folder lock sees to that), and memory will do.
const limiter = config.databaseUrl ? new DatabaseRateLimiter(db, config.limiterSecret) : new MemoryRateLimiter();
const ctx: Ctx = { db, now: () => new Date(), mailer, publicUrl: config.publicUrl, log, trustProxy: config.trustProxy, limiter };

const server = createApp(ctx).listen(config.port, () => log.info("listening", { port: config.port }));
const reminders = startReminderLoop(ctx);

// A host stops a server by asking first (SIGTERM). Finish what is in flight, then close the database
// properly: the built-in one in particular should not be cut off in the middle of a write.
let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("stopping", { signal });
  clearInterval(reminders);
  // Give open requests ten seconds, then go anyway.
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  await new Promise((resolve) => server.close(resolve));
  await db.close().catch((err: unknown) => log.error("database_close_failed", safeError(err)));
  releaseFolder();
  log.info("stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
