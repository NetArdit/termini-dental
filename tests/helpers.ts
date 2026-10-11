import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server/app";
import type { Ctx } from "../src/server/context";
import { openPostgres, type Db } from "../src/server/db";
import { openPglite } from "../src/server/db-local";
import { DatabaseRateLimiter } from "../src/server/limits";
import { createLogger } from "../src/server/log";

// A real server on a spare port, an in-memory database, a clock the test controls, and a mailer that
// records instead of sending. One app per test file: a second in-memory database in the same process runs
// this machine out of memory, so tests that need another time move the shared clock instead.

export interface TestApp {
  ctx: Ctx;
  base: string;
  sent: Array<{ to: string; subject: string; text: string }>;
  /** Moves the clock. */
  setNow(iso: string): void;
  /** When true, the fake mail server refuses every message. */
  failMail: { value: boolean };
  /** How long the fake mail server takes over each message. Zero unless a test is about two sends racing. */
  mailDelay: { ms: number };
  /** Every log line the server wrote, as the JSON text it would print. */
  logs: string[];
  close(): Promise<void>;
}

/**
 * A fresh, empty database on the PostgreSQL server named by PG_TEST_URL, and how to remove it again.
 * The user in that URL must be allowed to create databases.
 */
export async function createServerDatabase(serverUrl: string): Promise<{ url: string; drop(): Promise<void> }> {
  const { default: pg } = await import("pg");
  const name = `termini_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Pool({ connectionString: serverUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(serverUrl);
  target.pathname = `/${name}`;
  return {
    url: target.toString(),
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/**
 * The database of a test file. By default PostgreSQL in memory (PGlite). With PG_TEST_URL set, a database
 * of its own on that real server instead, so the whole suite can be run against real PostgreSQL:
 *   PG_TEST_URL=postgres://user:password@127.0.0.1:5432/postgres npm test
 * `database` lets a test bring its own.
 */
export async function startApp(nowIso = "2026-10-12T08:00:00Z", database?: Db): Promise<TestApp> {
  let dropDatabase: (() => Promise<void>) | undefined;
  let db: Db;
  if (database) db = database;
  else if (process.env.PG_TEST_URL) {
    const created = await createServerDatabase(process.env.PG_TEST_URL);
    dropDatabase = created.drop;
    db = await openPostgres(created.url);
  } else db = await openPglite();
  let now = new Date(nowIso);
  const sent: TestApp["sent"] = [];
  const failMail = { value: false };
  const mailDelay = { ms: 0 };
  const logs: string[] = [];
  const ctx: Ctx = {
    db,
    log: createLogger({ level: "debug", write: (line) => logs.push(line) }),
    // The database-backed limiter, on whichever engine the tests run: it is the one that matters when the
    // application runs as several instances.
    limiter: new DatabaseRateLimiter(db, "test-secret"),
    now: () => now,
    publicUrl: "http://test.local",
    maxBookingsPerHour: 1000,
    mailer: {
      async send(message) {
        if (mailDelay.ms) await new Promise((resolve) => setTimeout(resolve, mailDelay.ms));
        if (failMail.value) throw new Error("mail server refused");
        sent.push(message);
      },
    },
  };
  const server: Server = await new Promise((resolve) => {
    const s = createApp(ctx).listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    ctx,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    failMail,
    mailDelay,
    logs,
    setNow: (iso) => {
      now = new Date(iso);
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      await dropDatabase?.();
    },
  };
}

export interface Reply {
  status: number;
  // Test code reads many different shapes; typing each reply would add nothing here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export type Client = ReturnType<typeof client>;

/** A browser-like client: keeps the session cookie between calls. */
export function client(base: string) {
  let cookie = "";
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", "x-requested-with": "termini", cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }
  return {
    get: (path: string, headers?: Record<string, string>) => call("GET", path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => call("POST", path, body ?? {}, headers),
    put: (path: string, body?: unknown) => call("PUT", path, body ?? {}),
    patch: (path: string, body?: unknown) => call("PATCH", path, body ?? {}),
    del: (path: string) => call("DELETE", path),
  };
}

let counter = 0;

/** Signs a clinic up and returns its administrator's client plus the ids a test usually needs. */
export async function newClinic(app: TestApp, name = "Klinika Test") {
  counter += 1;
  const admin = client(app.base);
  const email = `admin${counter}@klinika.test`;
  const signup = await admin.post("/api/auth/signup", { clinicName: name, fullName: "Dr. Arta Krasniqi", email, password: "fjalekalimi1", isDentist: true });
  if (signup.status !== 201) throw new Error("signup failed: " + JSON.stringify(signup.data));
  const me = (await admin.get("/api/auth/me")).data;
  const services = (await admin.get("/api/services")).data.services as Array<{ id: number; name: string; durationMinutes: number }>;
  return {
    admin,
    email,
    clinic: me.clinic as { id: number; slug: string },
    adminId: me.user.id as number,
    services,
    checkup: services.find((s) => s.name === "Kontroll")!,
  };
}

/** Adds a dentist to a clinic and returns a logged-in client for them. */
export async function newDentist(app: TestApp, admin: Client, fullName = "Dr. Besnik Gashi") {
  counter += 1;
  const email = `dentist${counter}@klinika.test`;
  const created = await admin.post("/api/staff", { fullName, email, password: "fjalekalimi2", role: "dentist" });
  if (created.status !== 201) throw new Error("staff create failed: " + JSON.stringify(created.data));
  const c = client(app.base);
  await c.post("/api/auth/login", { email, password: "fjalekalimi2" });
  return { client: c, id: created.data.staff.id as number, email };
}

/** What a patient types into the booking form. Each call gets its own address, so bookings do not pile up on one person. */
export function patientInput(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    fullName: "Blerim Hoxha",
    phone: "+383 44 123 456",
    email: `pacient${counter}@example.test`,
    acceptNotice: true,
    ...overrides,
  };
}
