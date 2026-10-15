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
const ok = (value: unknown) => ({ status: "fulfilled" as const, value });
const no = (reason: unknown) => ({ status: "rejected" as const, reason });
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

  it("through the application: two administrators remove each other at the same moment, six times over", async () => {
    for (let round = 0; round < 6; round++) {
      const c = await newClinic(app);
      const second = await secondAdmin(c);
      const pair = await Promise.all([c.admin.patch(`/api/staff/${second.id}`, { isActive: false }), second.session.patch(`/api/staff/${c.adminId}`, { role: "dentist" })]);
      // One wins. The other is refused: as the would-be remover of the last administrator (409), or
      // because by then it is no longer an administrator, or no longer logged in (403, 401).
      expect(pair.filter((r) => r.status === 200)).toHaveLength(1);
      expect([401, 403, 409]).toContain(pair.find((r) => r.status !== 200)!.status);
      expect(await admins(c.clinic.id)).toBe(1);
      // No request ended in an unexplained server error.
      expect(pair.filter((r) => r.status >= 500)).toHaveLength(0);
    }
  });

  it("a report deleted and its visit marked completed at the same moment, in two sessions: never both", async () => {
    const c = await newClinic(app);
    for (let round = 0; round < 6; round++) {
      // A visit in the past with its report, the mark taken off: the report exists, the status is 'booked'.
      app.setNow("2026-10-12T06:00:00Z");
      const startsAt = `2026-10-12T${String(7 + round).padStart(2, "0")}:00:00.000Z`;
      const id = (await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt, newPatient: { fullName: `Pacient ${round}`, phone: "044 111 222" } })).data.id as number;
      app.setNow("2026-10-12T16:00:00Z");
      expect((await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Kontroll." })).status).toBe(200);
      expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "booked" })).status).toBe(200);

      const one = await raw.connect();
      const two = await raw.connect();
      try {
        await one.query("BEGIN");
        await two.query("BEGIN");
        // Each looks harmless alone: the report goes while the visit is not completed; the visit is
        // completed while its report is (as far as that session can see) still there.
        await one.query("DELETE FROM visit_reports WHERE appointment_id = $1", [id]);
        await two.query("UPDATE appointments SET status = 'completed' WHERE id = $1", [id]);
        // Three ways to finish, in turn: both commits at the same instant; the deletion first, which then
        // has to wait for the other session (so the other's commit must already be on its way: awaiting
        // the deletion alone would wait for ever); the mark first and whole, then the deletion.
        let outcome;
        if (round % 3 === 0) outcome = await Promise.allSettled([one.query("COMMIT"), two.query("COMMIT")]);
        else if (round % 3 === 1) {
          const first = one.query("COMMIT").then(ok, no);
          await new Promise((resolve) => setTimeout(resolve, 200));
          const second = await two.query("COMMIT").then(ok, no);
          outcome = [await first, second];
        } else outcome = [await two.query("COMMIT").then(ok, no), await one.query("COMMIT").then(ok, no)];
        expect(outcome.filter((o) => o.status === "fulfilled")).toHaveLength(1);
        expect((outcome.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "TD002" });
      } finally {
        await one.query("ROLLBACK").catch(() => {});
        await two.query("ROLLBACK").catch(() => {});
        one.release();
        two.release();
      }
      const state = (await db.query<{ status: string; reported: boolean }>("SELECT a.status, EXISTS (SELECT 1 FROM visit_reports r WHERE r.appointment_id = a.id) AS reported FROM appointments a WHERE a.id = $1", [id]))[0]!;
      expect(state.status === "completed" && !state.reported, JSON.stringify(state)).toBe(false);
    }
    app.setNow("2026-10-12T08:00:00Z");
  });

  it("two set-ups of the clinic at the same moment, over separate connections: one clinic", async () => {
    const { createClinic } = await import("../src/server/bootstrap");
    for (let round = 0; round < 5; round++) {
      await db.query("TRUNCATE clinics, rate_events RESTART IDENTITY CASCADE");
      const setup = (n: number) => createClinic(db, { clinicName: `Klinika ${n}`, adminName: "Dr. Arta Krasniqi", adminEmail: `arta-${round}-${n}@example.test`, password: "fjalekalimi1", isDentist: true });
      const outcome = await Promise.allSettled([setup(1), setup(2), setup(3)]);
      expect(outcome.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect((await db.query("SELECT 1 FROM clinics")).length).toBe(1);
      expect((await db.query("SELECT 1 FROM users")).length).toBe(1);
    }
  });

  it("many patients asking for one slot at the same moment: the exclusion constraint lets one in", async () => {
    const { clinic, checkup } = await newClinic(app);
    const book = () => client(app.base).post("/api/public/book", { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput() });
    const results = await Promise.all(Array.from({ length: 8 }, book));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM appointments WHERE clinic_id = $1 AND status <> 'cancelled'", [clinic.id]);
    expect(rows[0]!.n).toBe(1);
  });

  it("one booking sent many times at the same moment, over separate connections: one appointment, one link, one confirmation", async () => {
    const { admin, clinic, checkup } = await newClinic(app);
    // A second dentist, so that a second appointment would be possible if the tries were not held to one.
    await admin.post("/api/staff", { fullName: "Dr. Tjetër", email: `tjeter-${clinic.id}-${Date.now()}@klinika.test`, password: "fjalekalimi2", role: "dentist" });
    for (let round = 0; round < 5; round++) {
      // Five different hours of one working day.
      const startsAt = `2026-10-14T${String(7 + round).padStart(2, "0")}:00:00.000Z`;
      const who = patientInput();
      const before = app.sent.filter((m) => m.to === who.email).length;
      const results = await Promise.all(Array.from({ length: 8 }, () => client(app.base).post("/api/public/book", { serviceId: checkup.id, dentistId: null, startsAt, ...who })));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect(new Set(results.map((r) => r.data.token)).size).toBe(1);
      const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.clinic_id = $1 AND lower(p.email) = $2", [clinic.id, who.email]);
      expect(rows[0]!.n).toBe(1);
      expect((await db.query("SELECT 1 FROM patients WHERE clinic_id = $1 AND lower(email) = $2", [clinic.id, who.email])).length).toBe(1);
      expect((await db.query("SELECT 1 FROM email_log WHERE clinic_id = $1 AND to_email = $2", [clinic.id, who.email])).length).toBe(1);
      expect(app.sent.filter((m) => m.to === who.email).length - before).toBe(1);
    }
  });

  it("one appointment cancelled by the patient and by the clinic at the same moment, over separate connections: cancelled once, told once", async () => {
    const { admin, clinic, checkup } = await newClinic(app);
    for (let round = 0; round < 5; round++) {
      const who = patientInput();
      const startsAt = `2026-10-14T${String(7 + round).padStart(2, "0")}:00:00.000Z`;
      const booked = await client(app.base).post("/api/public/book", { serviceId: checkup.id, dentistId: null, startsAt, ...who });
      expect(booked.status).toBe(201);
      const token = booked.data.token as string;
      const id = (await db.query<{ id: number }>("SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.clinic_id = $1 AND lower(p.email) = $2", [clinic.id, who.email]))[0]!.id;
      const before = app.sent.filter((m) => m.to === who.email).length;
      const results = await Promise.all([
        client(app.base).post("/api/public/appointment/cancel", {}, { "x-appointment-token": token }),
        client(app.base).post("/api/public/appointment/cancel", {}, { "x-appointment-token": token }),
        admin.post(`/api/appointments/${id}/cancel`, { reason: "Njëkohësisht" }),
        admin.post(`/api/appointments/${id}/cancel`, { reason: "Njëkohësisht" }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
      expect((await db.query("SELECT 1 FROM email_log WHERE appointment_id = $1 AND kind IN ('cancelled_by_patient', 'cancelled_by_clinic')", [id])).length).toBe(1);
      expect((await db.query("SELECT 1 FROM audit_log WHERE entity = 'appointment' AND entity_id = $1 AND action LIKE 'appointment_cancelled%'", [id])).length).toBe(1);
      expect(app.sent.filter((m) => m.to === who.email).length - before).toBe(1);
      expect((await db.query<{ status: string; token_hash: string | null; mail_token_hashes: string[] }>("SELECT status, token_hash, mail_token_hashes FROM appointments WHERE id = $1", [id]))[0]).toEqual({ status: "cancelled", token_hash: null, mail_token_hashes: [] });
    }
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
