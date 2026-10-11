import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPostgres, type Db } from "../src/server/db";
import { client, newClinic, patientInput, startApp, type TestApp } from "./helpers";

// The same application on a real PostgreSQL server, with several connections at once. The other test files
// run on PGlite, which has one connection: there, two requests can never truly be inside a transaction at
// the same moment, so the races below cannot be shown. These tests are skipped unless a server is named:
//
//   PG_TEST_URL=postgres://user:password@127.0.0.1:5432/postgres npx vitest run tests/postgres.test.ts
//
// The user must be allowed to create a database: each run makes its own and drops it at the end.

const url = process.env.PG_TEST_URL;
const WED_0900 = "2026-10-14T07:00:00.000Z";

describe.skipIf(!url)("on a real PostgreSQL server, with concurrent connections", () => {
  const name = `termini_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let server: pg.Pool;
  let testUrl: string;
  let db: Db;
  let app: TestApp;
  /** Plain connections of our own, for transactions interleaved by hand. */
  let raw: pg.Pool;

  beforeAll(async () => {
    server = new pg.Pool({ connectionString: url, max: 1 });
    await server.query(`CREATE DATABASE ${name}`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    testUrl = target.toString();
    db = await openPostgres(testUrl);
    raw = new pg.Pool({ connectionString: testUrl, max: 4 });
    app = await startApp("2026-10-12T08:00:00Z", db);
  });

  afterAll(async () => {
    await raw?.end();
    await app?.close(); // closes the application's pool as well
    await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await server.end();
  });

  const admins = async (clinicId: number) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE clinic_id = $1 AND role = 'admin' AND is_active", [clinicId]))[0]!.n;
  const secondAdmin = async (c: Awaited<ReturnType<typeof newClinic>>) => {
    const email = `dy-${c.clinic.id}-${Math.floor(Math.random() * 1e9)}@klinika.test`;
    const id = (await c.admin.post("/api/staff", { fullName: "Dr. Dy Admin", email, password: "fjalekalimi2", role: "admin" })).data.staff.id as number;
    const session = client(app.base);
    await session.post("/api/auth/login", { email, password: "fjalekalimi2" });
    return { id, session };
  };

  it("accepts the whole schema, and accepts it again", async () => {
    await db.migrate();
    const tables = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    expect(tables[0]!.n).toBeGreaterThanOrEqual(10);
    expect(await db.query("SELECT 1 FROM pg_trigger WHERE tgname = 'users_clinic_keeps_an_administrator'")).toHaveLength(1);
  });

  it("two transactions that each remove a different administrator: the second to commit is refused", async () => {
    const c = await newClinic(app);
    const second = await secondAdmin(c);
    const one = await raw.connect();
    const two = await raw.connect();
    try {
      await one.query("BEGIN");
      await two.query("BEGIN");
      // Each sees the other administrator still in place, so each change looks harmless on its own.
      await one.query("UPDATE users SET role = 'dentist' WHERE id = $1", [c.adminId]);
      await two.query("UPDATE users SET is_active = FALSE WHERE id = $1", [second.id]);
      await one.query("COMMIT");
      await expect(two.query("COMMIT")).rejects.toMatchObject({ code: "TD001" });
    } finally {
      await one.query("ROLLBACK").catch(() => {});
      await two.query("ROLLBACK").catch(() => {});
      one.release();
      two.release();
    }
    expect(await admins(c.clinic.id)).toBe(1);
  });

  it("the same two transactions committing at the same instant: exactly one goes through", async () => {
    for (let round = 0; round < 5; round++) {
      const c = await newClinic(app);
      const second = await secondAdmin(c);
      const one = await raw.connect();
      const two = await raw.connect();
      try {
        await one.query("BEGIN");
        await two.query("BEGIN");
        await one.query("DELETE FROM sessions WHERE user_id = $1", [c.adminId]);
        await one.query("UPDATE users SET is_active = FALSE WHERE id = $1", [c.adminId]);
        await two.query("UPDATE users SET role = 'dentist' WHERE id = $1", [second.id]);
        const outcome = await Promise.allSettled([one.query("COMMIT"), two.query("COMMIT")]);
        expect(outcome.filter((o) => o.status === "fulfilled")).toHaveLength(1);
        expect((outcome.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "TD001" });
      } finally {
        await one.query("ROLLBACK").catch(() => {});
        await two.query("ROLLBACK").catch(() => {});
        one.release();
        two.release();
      }
      expect(await admins(c.clinic.id)).toBe(1);
    }
  });

  it("through the application: two administrators remove each other at the same moment, in many clinics at once", async () => {
    const clinics = [];
    for (let i = 0; i < 6; i++) {
      const c = await newClinic(app);
      clinics.push({ c, second: await secondAdmin(c) });
    }
    const results = await Promise.all(
      clinics.flatMap(({ c, second }) => [c.admin.patch(`/api/staff/${second.id}`, { isActive: false }), second.session.patch(`/api/staff/${c.adminId}`, { role: "dentist" })]),
    );
    for (let i = 0; i < clinics.length; i++) {
      const pair = [results[2 * i]!, results[2 * i + 1]!];
      // One wins. The other is refused: as the would-be remover of the last administrator (409), or
      // because by then it is no longer an administrator, or no longer logged in (403, 401).
      expect(pair.filter((r) => r.status === 200)).toHaveLength(1);
      expect([401, 403, 409]).toContain(pair.find((r) => r.status !== 200)!.status);
      expect(await admins(clinics[i]!.c.clinic.id)).toBe(1);
    }
    // No request ended in an unexplained server error.
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
  });

  it("many patients asking for one slot at the same moment: the exclusion constraint lets one in", async () => {
    const { clinic, checkup } = await newClinic(app);
    const book = () => client(app.base).post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput() });
    const results = await Promise.all(Array.from({ length: 8 }, book));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM appointments WHERE clinic_id = $1 AND status <> 'cancelled'", [clinic.id]);
    expect(rows[0]!.n).toBe(1);
  });

  it("two clicks on 'send again' at the same moment: the message goes out once", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = `dy-klikime-${Date.now()}@example.test`;
    const booked = await admin.post("/api/appointments", { dentistId: adminId, serviceId: checkup.id, startsAt: WED_0900, newPatient: { fullName: "Dy Klikime", phone: "044 111 222", email: to } });
    app.failMail.value = true;
    await admin.post(`/api/appointments/${booked.data.id}/cancel`, { reason: "Defekt" });
    app.failMail.value = false;
    const row = ((await admin.get("/api/emails")).data.emails as Array<{ id: number; to: string; kind: string }>).find((e) => e.to === to && e.kind === "cancelled_by_clinic")!;
    app.mailDelay.ms = 300;
    const both = await Promise.all([admin.post(`/api/emails/${row.id}/resend`), admin.post(`/api/emails/${row.id}/resend`)]);
    app.mailDelay.ms = 0;
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(app.sent.filter((m) => m.to === to && m.subject.includes("u anulua"))).toHaveLength(1);
  });
});
