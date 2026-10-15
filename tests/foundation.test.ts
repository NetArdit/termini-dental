import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootstrapError, checkFirstSetup, createClinic } from "../src/server/bootstrap";
import { client, emptyDatabase, newClinic, newDentist, startApp, type TestApp } from "./helpers";

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe("accounts and clinic setup", () => {
  it("setting the clinic up creates it, its administrator, default services and working hours", async () => {
    const { admin, clinic, adminId, services } = await newClinic(app, "Rrënja Dental");
    expect(clinic.name).toBe("Rrënja Dental");
    expect(JSON.stringify(clinic)).not.toMatch(/slug/);
    expect(services.length).toBeGreaterThanOrEqual(3);
    const hours = (await admin.get(`/api/staff/${adminId}/hours`)).data.hours;
    expect(hours).toHaveLength(5);
    expect(hours[0]).toEqual({ weekday: 1, startMinute: 540, endMinute: 1020 });
  });

  it("nothing reachable from the internet creates a clinic or an administrator", async () => {
    await emptyDatabase(app);
    const anybody = client(app.base);
    const wanted = { clinicName: "Klinika Ime", fullName: "Dikush Tjetër", email: "dikush@example.test", password: "fjalekalimi1", isDentist: true };
    for (const address of ["/api/auth/signup", "/api/auth/register", "/api/clinics", "/api/public/clinics", "/api/public/clinic", "/api/staff"]) {
      const res = await anybody.post(address, wanted);
      expect([401, 404], address).toContain(res.status);
    }
    expect((await app.ctx.db.query("SELECT 1 FROM clinics")).length).toBe(0);
    expect((await app.ctx.db.query("SELECT 1 FROM users")).length).toBe(0);
    // Before the clinic is set up, its public pages say so instead of failing.
    expect((await anybody.get("/api/public/clinic")).status).toBe(503);
    // With a clinic there, the same requests still create nothing.
    const { clinic } = await newClinic(app);
    for (const address of ["/api/auth/signup", "/api/clinics", "/api/staff"]) expect([401, 404], address).toContain((await client(app.base).post(address, wanted)).status);
    expect((await app.ctx.db.query<{ id: number }>("SELECT id FROM clinics")).map((c) => c.id)).toEqual([clinic.id]);
    expect((await app.ctx.db.query("SELECT 1 FROM users")).length).toBe(1);
  });

  it("the set-up refuses to run twice: no second clinic, and the administrator's password stays as it was", async () => {
    const { email } = await newClinic(app);
    const before = (await app.ctx.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", [email]))[0]!.password_hash;
    await expect(createClinic(app.ctx.db, { clinicName: "E dyta", adminName: "Dikush Tjetër", adminEmail: "tjeter@example.test", password: "fjalekalimi9", isDentist: false })).rejects.toThrow(BootstrapError);
    await expect(createClinic(app.ctx.db, { clinicName: "Rrënja Dental", adminName: "Dr. Arta Krasniqi", adminEmail: email, password: "nje-tjeter-123", isDentist: true })).rejects.toThrow(/already has its clinic/);
    expect((await app.ctx.db.query("SELECT 1 FROM clinics")).length).toBe(1);
    expect((await app.ctx.db.query("SELECT 1 FROM users")).length).toBe(1);
    expect((await app.ctx.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", [email]))[0]!.password_hash).toBe(before);
    expect((await client(app.base).post("/api/auth/login", { email, password: "nje-tjeter-123" })).status).toBe(401);
  });

  it("the set-up checks what it is given, and stores nothing when something is wrong", async () => {
    await emptyDatabase(app);
    const good = { clinicName: "Rrënja Dental", adminName: "Dr. Arta Krasniqi", adminEmail: "arta@example.test", password: "fjalekalimi1", isDentist: true };
    for (const wrong of [{ clinicName: " " }, { adminName: "A" }, { adminEmail: "not-an-address" }, { password: "short" }]) {
      await expect(createClinic(app.ctx.db, { ...good, ...wrong })).rejects.toThrow(BootstrapError);
    }
    expect((await app.ctx.db.query("SELECT 1 FROM clinics")).length).toBe(0);
    expect(checkFirstSetup({ ...good, adminEmail: "  Arta@Example.Test " }).adminEmail).toBe("arta@example.test");
  });

  it("the database itself refuses a second clinic, whoever asks", async () => {
    await newClinic(app);
    const second = app.ctx.db.tx(async (q) => {
      const id = (await q.query<{ id: number }>("INSERT INTO clinics (name) VALUES ('E dyta') RETURNING id"))[0]!.id;
      await q.query("INSERT INTO users (clinic_id, role, full_name, email, password_hash) VALUES ($1, 'admin', 'Dikush', 'dikush@example.test', 'x')", [id]);
    });
    await expect(second).rejects.toThrow();
    expect((await app.ctx.db.query("SELECT 1 FROM clinics")).length).toBe(1);
    await expect(app.ctx.db.query("UPDATE clinics SET the_only_one = FALSE")).rejects.toThrow();
  });

  it("a database that still holds several clinics is not converted, and nothing in it is changed", async () => {
    const old = await startApp();
    try {
      const db = old.ctx.db;
      // The database as it stood before migration 006, with two clinics in it.
      for (const sql of [
        "DROP INDEX clinics_the_only_one_idx",
        "ALTER TABLE clinics DROP CONSTRAINT clinics_the_only_one_check",
        "ALTER TABLE clinics DROP COLUMN the_only_one",
        "ALTER TABLE clinics ADD COLUMN slug TEXT UNIQUE",
        "DELETE FROM schema_migrations WHERE version = 6",
      ]) await db.query(sql);
      for (const name of ["Klinika Një", "Klinika Dy"]) {
        await db.tx(async (q) => {
          const id = (await q.query<{ id: number }>("INSERT INTO clinics (name, slug) VALUES ($1, $2) RETURNING id", [name, name.toLowerCase().replace(" ", "-")]))[0]!.id;
          await q.query("INSERT INTO users (clinic_id, role, full_name, email, password_hash) VALUES ($1, 'admin', 'Administrator', $2, 'x')", [id, `admin-${id}@example.test`]);
          await q.query("INSERT INTO services (clinic_id, name, duration_minutes) VALUES ($1, 'Kontroll', 30)", [id]);
        });
      }
      const picture = async () => JSON.stringify([await db.query("SELECT * FROM clinics ORDER BY id"), await db.query("SELECT id, clinic_id, email FROM users ORDER BY id"), await db.query("SELECT * FROM services ORDER BY id"), await db.query("SELECT version FROM schema_migrations ORDER BY version")]);
      const before = await picture();
      await expect(db.migrate()).rejects.toThrow(/holds 2 clinics/);
      expect(await picture()).toBe(before);
      // A person decides which clinic stays; then the migration goes through and keeps what is there.
      await db.query("DELETE FROM clinics WHERE name = 'Klinika Dy'");
      expect((await db.migrate()).applied.map((m) => m.version)).toEqual([6]);
      const kept = await db.query<Record<string, unknown>>("SELECT * FROM clinics");
      expect(kept).toHaveLength(1);
      expect(kept[0]!.name).toBe("Klinika Një");
      expect(Object.keys(kept[0]!)).not.toContain("slug");
      expect((await db.query("SELECT 1 FROM users")).length).toBe(1);
      expect((await db.query("SELECT 1 FROM services")).length).toBe(1);
      expect((await db.migrate()).applied).toEqual([]);
    } finally {
      await old.close();
    }
  });

  it("login answers the same for a wrong password and an unknown account", async () => {
    const { email } = await newClinic(app);
    const c = client(app.base);
    const wrong = await c.post("/api/auth/login", { email, password: "gabim-gabim" });
    const unknown = await c.post("/api/auth/login", { email: "askush@klinika.test", password: "gabim-gabim" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.data.error).toBe(unknown.data.error);
    expect((await c.post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(200);
    expect((await c.get("/api/auth/me")).status).toBe(200);
    await c.post("/api/auth/logout");
    expect((await c.get("/api/auth/me")).status).toBe(401);
  });

  it("stops password guessing after eight failures, for fifteen minutes, without keeping the count for ever", async () => {
    const { email } = await newClinic(app);
    const c = client(app.base);
    for (let i = 0; i < 8; i++) expect((await c.post("/api/auth/login", { email, password: "gabim-gabim" })).status).toBe(401);
    // Locked: even the right password is refused now.
    expect((await c.post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(429);
    // The refused attempt is not counted on top: eight are on record, not nine.
    const counted = async () => (await app.ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM rate_events WHERE bucket = 'login'"))[0]!.n;
    const start = await counted();
    expect(start).toBeGreaterThanOrEqual(8);
    expect((await c.post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(429);
    expect(await counted()).toBe(start);
    app.setNow("2026-10-12T08:15:01Z");
    expect((await c.post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(200);
    // A successful login leaves nothing behind for that person.
    expect(await counted()).toBe(start - 8);
    // Someone who fails and never comes back: their count is removed by the housekeeping, an hour on.
    expect((await client(app.base).post("/api/auth/login", { email: "tjeter@klinika.test", password: "gabim-gabim" })).status).toBe(401);
    expect(await counted()).toBe(start - 8 + 1);
    await app.ctx.limiter!.prune(new Date("2026-10-12T09:15:02Z"));
    expect(await counted()).toBe(0);
    app.setNow("2026-10-12T08:00:00Z");
  });

  it("a burst of guesses sent at the same moment gets eight tries, not twenty", async () => {
    const { email } = await newClinic(app);
    await app.ctx.limiter!.reset("login");
    const guesses = await Promise.all(Array.from({ length: 20 }, (_, i) => client(app.base).post("/api/auth/login", { email, password: `hamendje-${i}` })));
    expect(guesses.filter((r) => r.status === 401)).toHaveLength(8);
    expect(guesses.filter((r) => r.status === 429)).toHaveLength(12);
    // And the ninth try is refused even with the right password, as for guesses sent one by one.
    expect((await client(app.base).post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(429);
    expect((await app.ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM rate_events WHERE bucket = 'login'"))[0]!.n).toBe(8);
    await app.ctx.limiter!.reset("login");
  });

  it("counts by the address the host vouches for, whatever the visitor claims about itself", async () => {
    const { email } = await newClinic(app);
    await app.ctx.limiter!.reset("login");
    // As on a host that hands over the visitor's address in a header of its own.
    app.ctx.clientAddress = (req) => req.get("x-host-says");
    try {
      const guess = (hostSays: string, claimed: string) => client(app.base).post("/api/auth/login", { email, password: "gabim-gabim" }, { "x-host-says": hostSays, "x-forwarded-for": claimed });
      for (let i = 0; i < 8; i++) expect((await guess("203.0.113.7", `198.51.100.${i}`)).status).toBe(401);
      // A ninth try from the same real address, claiming to be yet another one: refused.
      expect((await guess("203.0.113.7", "198.51.100.99")).status).toBe(429);
      // A different real address is a different counter.
      expect((await guess("203.0.113.8", "198.51.100.1")).status).toBe(401);
    } finally {
      delete app.ctx.clientAddress;
      await app.ctx.limiter!.reset("login");
    }
  });

  it("the counters name nobody: no email address and no network address is stored", async () => {
    const { email } = await newClinic(app);
    await app.ctx.limiter!.reset("login");
    await client(app.base).post("/api/auth/login", { email, password: "gabim-gabim" });
    const rows = await app.ctx.db.query<{ bucket: string; key_hash: string }>("SELECT bucket, key_hash FROM rate_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.stringify(rows);
    for (const part of [email, email.split("@")[0]!, "127.0.0.1", "::1", "::ffff"]) expect(stored).not.toContain(part);
    // The same person from the same address is the same counter; another person is another.
    await client(app.base).post("/api/auth/login", { email, password: "gabim-gabim" });
    await client(app.base).post("/api/auth/login", { email: "dikush-tjeter@klinika.test", password: "gabim-gabim" });
    const counters = await app.ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM rate_events GROUP BY key_hash ORDER BY n DESC");
    expect(counters.map((c) => c.n)).toEqual([2, 1]);
    await app.ctx.limiter!.reset("login");
  });

  it("a request that changes something without the anti-forgery header is refused", async () => {
    const res = await fetch(app.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });

  it("only an administrator manages staff, services and clinic settings", async () => {
    const { admin } = await newClinic(app);
    const dentist = await newDentist(app, admin);
    expect((await dentist.client.post("/api/staff", { fullName: "Tjetër Dikush", email: "x@klinika.test", password: "fjalekalimi3" })).status).toBe(403);
    expect((await dentist.client.post("/api/services", { name: "Zbardhim", durationMinutes: 60 })).status).toBe(403);
    expect((await dentist.client.patch("/api/clinic", { bookingNoticeHours: 0 })).status).toBe(403);
    expect((await admin.patch("/api/clinic", { phone: "+383 38 000 000" })).data.clinic.phone).toBe("+383 38 000 000");
  });

  it("a member of staff who does not exist is not found, and staff are out of reach without signing in", async () => {
    const { admin } = await newClinic(app);
    expect((await admin.get("/api/staff/99999999/hours")).status).toBe(404);
    expect((await admin.patch("/api/staff/99999999", { isActive: false })).status).toBe(404);
    expect((await client(app.base).get("/api/staff")).status).toBe(401);
  });

  it("a clinic cannot lose its last active administrator", async () => {
    const { admin, adminId } = await newClinic(app);
    expect((await admin.patch(`/api/staff/${adminId}`, { role: "dentist" })).status).toBe(409);
    expect((await admin.patch(`/api/staff/${adminId}`, { isActive: false })).status).toBe(409);
  });

  describe("the last administrator, guarded by the database itself", () => {
    const admins = async (clinicId: number) => (await app.ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE clinic_id = $1 AND role = 'admin' AND is_active", [clinicId]))[0]!.n;
    const refused = (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code: "TD001" });

    it("refuses to demote, deactivate or delete the only administrator, even when the application is bypassed", async () => {
      const { clinic, adminId } = await newClinic(app);
      const db = app.ctx.db;
      await refused(db.query("UPDATE users SET role = 'dentist' WHERE id = $1", [adminId]));
      await refused(db.query("UPDATE users SET is_active = FALSE WHERE id = $1", [adminId]));
      await refused(db.query("DELETE FROM users WHERE id = $1", [adminId]));
      expect(await admins(clinic.id)).toBe(1);
      // Everything else about that account can still change.
      await db.query("UPDATE users SET full_name = 'Dr. Arta K.', password_hash = 'x' WHERE id = $1", [adminId]);
    });

    it("judges the whole transaction: both administrators gone is refused, a handover is allowed", async () => {
      const { admin, clinic, adminId } = await newClinic(app);
      const second = (await admin.post("/api/staff", { fullName: "Dr. Dy Admin", email: `dy-admin-${clinic.id}@klinika.test`, password: "fjalekalimi2", role: "admin" })).data.staff.id as number;
      const db = app.ctx.db;
      await refused(
        db.tx(async (q) => {
          await q.query("UPDATE users SET role = 'dentist' WHERE id = $1", [adminId]);
          await q.query("UPDATE users SET is_active = FALSE WHERE id = $1", [second]);
        }),
      );
      // Rolled back as a whole: both are still administrators.
      expect(await admins(clinic.id)).toBe(2);
      // One of two may go...
      await db.query("UPDATE users SET role = 'dentist' WHERE id = $1", [second]);
      // ...and the role can be handed over in one step, although halfway through nobody holds it.
      await db.tx(async (q) => {
        await q.query("UPDATE users SET role = 'dentist' WHERE id = $1", [adminId]);
        await q.query("UPDATE users SET role = 'admin' WHERE id = $1", [second]);
      });
      expect(await admins(clinic.id)).toBe(1);
    });

    it("refuses a clinic created without an administrator, and lets a clinic be removed whole", async () => {
      const db = app.ctx.db;
      await emptyDatabase(app);
      await refused(db.query("INSERT INTO clinics (name) VALUES ('Pa Administrator')"));
      expect(await db.query("SELECT 1 FROM clinics")).toHaveLength(0);
      const { clinic } = await newClinic(app);
      await db.query("DELETE FROM clinics WHERE id = $1", [clinic.id]);
      expect(await db.query("SELECT 1 FROM users WHERE clinic_id = $1", [clinic.id])).toHaveLength(0);
    });

    it("two administrators who remove each other at the same moment: one is refused", async () => {
      const a = await newClinic(app);
      const email = `tjetri-${a.clinic.id}@klinika.test`;
      const bId = (await a.admin.post("/api/staff", { fullName: "Dr. Tjetri", email, password: "fjalekalimi2", role: "admin" })).data.staff.id as number;
      const b = client(app.base);
      await b.post("/api/auth/login", { email, password: "fjalekalimi2" });
      const both = await Promise.all([a.admin.patch(`/api/staff/${bId}`, { isActive: false }), b.patch(`/api/staff/${a.adminId}`, { role: "dentist" })]);
      // Whoever comes second is no longer an administrator (403) or would remove the last one (409).
      expect(both.filter((r) => r.status === 200)).toHaveLength(1);
      expect([403, 409, 401]).toContain(both.find((r) => r.status !== 200)!.status);
      expect(await admins(a.clinic.id)).toBe(1);
    });
  });

  it("deactivating a dentist ends their session at once", async () => {
    const { admin } = await newClinic(app);
    const dentist = await newDentist(app, admin);
    expect((await dentist.client.get("/api/auth/me")).status).toBe(200);
    await admin.patch(`/api/staff/${dentist.id}`, { isActive: false });
    expect((await dentist.client.get("/api/auth/me")).status).toBe(401);
    expect((await client(app.base).post("/api/auth/login", { email: dentist.email, password: "fjalekalimi2" })).status).toBe(401);
  });

  it("a dentist edits their own working hours but not a colleague's; overlapping periods are refused", async () => {
    const { admin, adminId } = await newClinic(app);
    const dentist = await newDentist(app, admin);
    const mine = await dentist.client.put(`/api/staff/${dentist.id}/hours`, {
      hours: [
        { weekday: 1, startMinute: 480, endMinute: 720 },
        { weekday: 1, startMinute: 780, endMinute: 960 },
      ],
    });
    expect(mine.status).toBe(200);
    expect((await dentist.client.put(`/api/staff/${adminId}/hours`, { hours: [] })).status).toBe(403);
    const overlap = await dentist.client.put(`/api/staff/${dentist.id}/hours`, {
      hours: [
        { weekday: 2, startMinute: 480, endMinute: 720 },
        { weekday: 2, startMinute: 700, endMinute: 900 },
      ],
    });
    expect(overlap.status).toBe(400);
    expect((await dentist.client.get(`/api/staff/${dentist.id}/hours`)).data.hours).toHaveLength(2);
  });
});
