import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One small interface over PostgreSQL so the same SQL runs on PGlite (PostgreSQL compiled to WebAssembly,
// inside this process: development and tests) and on a real PostgreSQL server (production).
// The built-in database is opened by db-local.ts, a file of its own: code that only ever talks to a database
// server (a serverless function) can then be packaged without the large WebAssembly file.

export type Row = Record<string, unknown>;

export interface Queryer {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryer {
  /** Runs `fn` inside one transaction; a thrown error rolls everything back. */
  tx<T>(fn: (q: Queryer) => Promise<T>): Promise<T>;
  /** Applies the migrations that have not been applied yet. Runs when the database is opened; safe to run again. */
  migrate(migrations?: Migration[]): Promise<MigrationReport>;
  close(): Promise<void>;
}

// ---- migrations ---------------------------------------------------------------------------------------------
//
// The tables are described by the numbered files in ./migrations, applied in order, each exactly once and
// each in its own transaction. Which ones a database has had is written in its table schema_migrations.
//
// Rules for whoever changes the tables:
//   - Never edit a migration that has been applied anywhere. Add a new file with the next number.
//   - A file is NNN_short_name.sql. It must leave the data it finds intact and usable.
//   - 001_baseline.sql is the schema as it stood when migrations were introduced. It is written so that it
//     can run on an empty database and on one created by the earlier, unversioned schema file, which is how
//     existing databases are adopted.

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationReport {
  /** Versions applied by this call, in order. Empty when the database was already up to date. */
  applied: Array<{ version: number; name: string }>;
  /** The version the database is at now. */
  current: number;
}

/** The database and the code disagree about the migrations. Starting anyway could damage data. */
export class MigrationError extends Error {}

// Worked out when asked for, not when this file loads: packaged as a serverless function this file has no
// folder of its own, and there the migrations are never read.
const migrationsDir = () => fileURLToPath(new URL("./migrations/", import.meta.url));

/** Line endings differ between machines (git on Windows rewrites them); the checksum must not. */
const checksumOf = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

export function loadMigrations(dir = migrationsDir()): Migration[] {
  const found = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(file);
      if (!match) throw new MigrationError(`Migration file "${file}" is not named NNN_short_name.sql.`);
      const sql = readFileSync(path.join(dir, file), "utf8");
      return { version: Number(match[1]), name: match[2]!, sql, checksum: checksumOf(sql) };
    });
  found.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`Migrations must be numbered 001, 002, ... without gaps; found ${m.version} in position ${i + 1}.`);
  });
  return found;
}

/** What the runner needs from a driver inside one transaction: whole scripts, and single statements. */
interface Session {
  exec(sql: string): Promise<void>;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}
type InTransaction = <T>(fn: (s: Session) => Promise<T>) => Promise<T>;

/** One number for "this application is changing the schema", so two processes starting at once take turns. */
const MIGRATION_LOCK = 746100101;

export async function runMigrations(inTransaction: InTransaction, migrations = loadMigrations()): Promise<MigrationReport> {
  const applied: MigrationReport["applied"] = [];
  const known = await inTransaction(async (s) => {
    await s.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await s.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    return s.query<{ version: number; name: string; checksum: string }>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
  });

  for (const row of known) {
    const mine = migrations.find((m) => m.version === row.version);
    if (!mine) {
      throw new MigrationError(
        `This database has migration ${row.version} (${row.name}), which this version of the application does not know. It was last used by a newer version. Start that version, or restore a backup taken before the upgrade.`,
      );
    }
    if (mine.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) was changed after it was applied to this database. Applied migrations must not be edited: put the file back as it was and make the change in a new migration.`,
      );
    }
  }

  for (const migration of migrations) {
    if (known.some((row) => row.version === migration.version)) continue;
    const done = await inTransaction(async (s) => {
      await s.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      // Another process may have applied it while this one waited for the lock.
      const already = await s.query("SELECT 1 FROM schema_migrations WHERE version = $1", [migration.version]);
      if (already.length) return false;
      await s.exec(migration.sql);
      await s.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [migration.version, migration.name, migration.checksum]);
      return true;
    });
    if (done) applied.push({ version: migration.version, name: migration.name });
  }
  return { applied, current: migrations.length };
}

/** The version a database is at, or 0 when it has never been migrated. */
export async function schemaVersion(q: Queryer): Promise<number> {
  const table = await q.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_migrations'");
  if (!table.length) return 0;
  const rows = await q.query<{ v: number | null }>("SELECT max(version)::int AS v FROM schema_migrations");
  return rows[0]?.v ?? 0;
}

// ---- drivers ------------------------------------------------------------------------------------------------

export interface PostgresOptions {
  /**
   * False where the migrations are applied by a step of their own before the code goes live, and must not
   * run when the application merely starts (a serverless function starts often, and without the .sql files).
   */
  migrate?: boolean;
  /** Most connections this process keeps open. A serverless instance needs very few. Default: 10, as the driver has it. */
  maxConnections?: number;
  /** Close a connection that has been idle this long. Default: 10 seconds, as the driver has it. */
  idleMs?: number;
}

export async function openPostgres(connectionString: string, options: PostgresOptions = {}): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, ...(options.maxConnections ? { max: options.maxConnections } : {}), ...(options.idleMs ? { idleTimeoutMillis: options.idleMs } : {}) });
  // A connection that is resting can be closed from the other end (a database that goes to sleep, a
  // function instance that was frozen). The pool drops it and opens another on the next query; without a
  // listener that event would stop the whole process.
  pool.on("error", () => {});
  async function tx<T>(fn: (q: Queryer & { exec(sql: string): Promise<void> }) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({
        async query<R>(sql: string, params: unknown[] = []) {
          return (await client.query(sql, params)).rows as R[];
        },
        // Without parameters the driver sends the text as it is, so a whole script runs in one go.
        async exec(sql: string) {
          await client.query(sql);
        },
      });
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  const migrate = (migrations?: Migration[]) => runMigrations(tx, migrations);
  try {
    if (options.migrate !== false) await migrate();
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    tx,
    migrate,
    close: () => pool.end(),
  };
}

/** PostgreSQL error code of a failed statement, on either driver. */
export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

/** 23P01: an exclusion constraint refused the row (here: an overlapping appointment). */
export const EXCLUSION_VIOLATION = "23P01";
/** 23505: a unique constraint refused the row. */
export const UNIQUE_VIOLATION = "23505";
/** TD001 (ours, raised by clinic_keeps_an_administrator in the baseline migration): the change would leave a clinic without an active administrator. */
export const LAST_ADMINISTRATOR = "TD001";
/** TD002 (ours, raised by completed_needs_a_report in migration 007): an appointment would be completed without a visit report. */
export const COMPLETED_WITHOUT_REPORT = "TD002";
/** TD003 (ours, same function): an appointment that has a visit report would be marked as not attended. */
export const NO_SHOW_WITH_REPORT = "TD003";
