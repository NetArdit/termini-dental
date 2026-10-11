import { schemaVersion, type Db } from "./db";

// A backup the application makes and reads itself: every table's rows as JSON, in one file. It needs no
// database tools on the machine and works the same on the built-in database and on a PostgreSQL server, so
// it is also the way to move a clinic from one to the other.
//
// The database does the converting in both directions (row_to_json out, json_populate_recordset in), so
// every value comes back as exactly the type it was: instants as instants, dates as dates.
//
// On a hosted PostgreSQL the provider's own backups and pg_dump remain the first line; see docs/OPERATIONS.md.
// A backup file holds patient data in the clear. Keep it where patient records may be kept.

/**
 * Every table that holds the clinic's data, parents before children. `key` orders the rows.
 * `instants` names the columns that hold a moment in time (timestamptz), and only those: when two backups
 * are compared, these are compared as moments, everything else as it is written. A test holds this list
 * against the database, so a column added later cannot be forgotten, and no text column can slip in.
 */
const TABLES: Array<{ name: string; key: string; identity: boolean; instants: string[] }> = [
  { name: "clinics", key: "id", identity: true, instants: ["created_at"] },
  { name: "users", key: "id", identity: true, instants: ["created_at"] },
  { name: "services", key: "id", identity: true, instants: ["created_at"] },
  { name: "working_hours", key: "id", identity: true, instants: [] },
  { name: "time_off", key: "id", identity: true, instants: ["starts_at", "ends_at"] },
  { name: "patients", key: "id", identity: true, instants: ["created_at", "updated_at"] },
  { name: "appointments", key: "id", identity: true, instants: ["starts_at", "ends_at", "notice_accepted_at", "cancelled_at", "reminder_sent_at", "created_at"] },
  { name: "visit_reports", key: "appointment_id", identity: false, instants: ["created_at", "updated_at"] },
  { name: "visit_report_versions", key: "id", identity: true, instants: ["saved_at"] },
  { name: "email_log", key: "id", identity: true, instants: ["last_attempt_at", "sending_since", "created_at"] },
  { name: "audit_log", key: "id", identity: true, instants: ["created_at"] },
];

/** Table name -> its columns that hold a moment in time. For the test that checks the list above. */
export const INSTANT_COLUMNS: Record<string, string[]> = Object.fromEntries(TABLES.map((t) => [t.name, t.instants]));

/** Tables left out on purpose: who is logged in right now, the migration bookkeeping, and the short-lived rate-limit counters. */
export const NOT_BACKED_UP = ["sessions", "schema_migrations", "rate_events"];
export const BACKED_UP = TABLES.map((t) => t.name);

export interface Backup {
  format: 1;
  app: "termini-dental";
  /** The migration version the data was written by. A backup is restored into a database at this version. */
  schemaVersion: number;
  createdAt: string;
  tables: Record<string, unknown[]>;
}

export class BackupError extends Error {}

export async function exportBackup(db: Db, now: Date): Promise<Backup> {
  // One transaction, so the tables are read as of one moment and fit together.
  return db.tx(async (q) => {
    await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    // Instants are written in UTC, whatever timezone this database session happens to be in. The instant
    // is the same either way; this makes two backups of the same records the same text as well.
    await q.query("SET LOCAL TIME ZONE 'UTC'");
    const tables: Backup["tables"] = {};
    for (const table of TABLES) {
      const rows = await q.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM ${table.name} t ORDER BY t.${table.key}`);
      tables[table.name] = rows.map((r) => JSON.parse(r.row) as unknown);
    }
    return { format: 1, app: "termini-dental", schemaVersion: await schemaVersion(q), createdAt: now.toISOString(), tables };
  });
}

export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError("This file is not a backup: it is not JSON.");
  }
  const b = data as Partial<Backup>;
  if (!b || b.app !== "termini-dental" || b.format !== 1 || typeof b.schemaVersion !== "number" || typeof b.tables !== "object" || b.tables === null) {
    throw new BackupError("This file is not a Termini Dental backup of a format this version can read.");
  }
  for (const table of BACKED_UP) if (!Array.isArray(b.tables[table])) throw new BackupError(`The backup has no table "${table}". It is incomplete or was made by another version.`);
  return b as Backup;
}

/**
 * Puts a backup into an EMPTY database, all of it or none of it. Refuses a database that already holds a
 * clinic: merging two sets of records is not something to do by accident.
 * Returns the number of rows restored per table.
 */
export async function restoreBackup(db: Db, backup: Backup): Promise<Record<string, number>> {
  const current = await schemaVersion(db);
  if (backup.schemaVersion > current) {
    throw new BackupError(`The backup is from schema version ${backup.schemaVersion}; this application only knows up to ${current}. Restore it with the newer version that made it.`);
  }
  if (backup.schemaVersion < current) {
    throw new BackupError(
      `The backup is from schema version ${backup.schemaVersion} and this database is at ${current}. Restore it with the application version that made it (an empty database, then restore, then upgrade), so that the migrations in between are applied to the data.`,
    );
  }
  const counts: Record<string, number> = {};
  await db.tx(async (q) => {
    for (const table of [...BACKED_UP, "sessions"]) {
      const any = await q.query(`SELECT 1 FROM ${table} LIMIT 1`);
      if (any.length) throw new BackupError(`This database is not empty (table "${table}" has rows). A backup is restored into an empty database only.`);
    }
    for (const table of TABLES) {
      const rows = backup.tables[table.name]!;
      for (let i = 0; i < rows.length; i += 500) {
        // The ids are part of the records (reports point at appointments by id), so they are kept as they were.
        await q.query(`INSERT INTO ${table.name} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${table.name}, $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
      }
      counts[table.name] = rows.length;
      // New rows must continue after the highest id that was restored.
      if (table.identity && rows.length) {
        await q.query(`SELECT setval(pg_get_serial_sequence('${table.name}', '${table.key}'), (SELECT max(${table.key}) FROM ${table.name}))`);
      }
    }
  });
  return counts;
}

/**
 * A record as text, with its fields in alphabetical order. The order in which a database lists a table's
 * columns depends on its history (a column added by a migration comes last; in a fresh database it sits
 * where the baseline put it), so two equal records can arrive with their fields in different order.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * An instant written with an offset ("2026-10-11T01:31:32.536855+01:00") as the same instant in UTC, to the
 * microsecond; null for any other text. A backup made in a session with another timezone writes the same
 * moment differently, and the same moment must compare as the same.
 */
function instant(text: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(text);
  if (!m) return null;
  const offset = m[3] === "Z" ? "+00:00" : m[3]!.length === 3 ? `${m[3]}:00` : m[3]!.length === 5 ? `${m[3]!.slice(0, 3)}:${m[3]!.slice(3)}` : m[3]!;
  const seconds = Date.parse(`${m[1]}${offset}`);
  if (Number.isNaN(seconds)) return null;
  return `${new Date(seconds).toISOString().slice(0, 19)}.${(m[2] ?? "").padEnd(6, "0")}Z`;
}

/** True when two backups hold the same records (when they were made does not count). */
export function sameContent(a: Backup, b: Backup): { same: boolean; firstDifference?: string } {
  if (a.schemaVersion !== b.schemaVersion) return { same: false, firstDifference: `schema version ${a.schemaVersion} against ${b.schemaVersion}` };
  for (const { name: table, instants } of TABLES) {
    const [x, y] = [a.tables[table]!, b.tables[table]!];
    if (x.length !== y.length) return { same: false, firstDifference: `${table}: ${x.length} rows against ${y.length}` };
    // A moment in time is compared as a moment, but only in the columns that hold one. Any other text is
    // compared exactly as written, also when it happens to look like a date: a note that says
    // "2026-10-11T09:00:00+02:00" is a note, and a changed note is a difference.
    const field = (column: string, value: unknown) => canonical(instants.includes(column) && typeof value === "string" ? (instant(value) ?? value) : value);
    for (let i = 0; i < x.length; i++) {
      const [a2, b2] = [(x[i] ?? {}) as Record<string, unknown>, (y[i] ?? {}) as Record<string, unknown>];
      // Which fields, never their contents: a difference report must not carry patient data.
      const fields = [...new Set([...Object.keys(a2), ...Object.keys(b2)])].filter((k) => !(k in a2) || !(k in b2) || field(k, a2[k]) !== field(k, b2[k]));
      if (fields.length) return { same: false, firstDifference: `${table}: row ${i + 1} differs in ${fields.sort().join(", ")}` };
    }
  }
  return { same: true };
}
