import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKED_UP, BackupError, INSTANT_COLUMNS, NOT_BACKED_UP, exportBackup, parseBackup, restoreBackup, sameContent, type Backup } from "../src/server/backup";
import { ConfigError, describeConfig, readConfig } from "../src/server/config";
import { MigrationError, loadMigrations, schemaVersion, type Migration } from "../src/server/db";
import { createLogger, safeError } from "../src/server/log";
import { client, newClinic, newDentist, patientInput, startApp, type TestApp } from "./helpers";

// Keeping the thing running: migrations, backups, configuration, logs.
// Two databases are needed (one to back up, one to restore into). They are opened one after the other,
// never together: this machine cannot hold two in-memory databases at once.

const NOW = "2026-10-12T08:00:00Z";
const WED_0900 = "2026-10-14T07:00:00.000Z";
const SECRETS = { name: "Zana Sekreti", email: "zana.sekreti@example.test", phone: "044 987 654", note: "Alergji në lateks", password: "fjalekalimi-shume-sekret" };

let backup: Backup;
let source: { logs: string[]; token: string; adminEmail: string; patientId: number; counts: Record<string, number> };

describe("backup, then restore into an empty database", () => {
  let app: TestApp;

  beforeAll(async () => {
    // ---- the clinic that gets backed up ----
    const first = await startApp(NOW);
    const c = await newClinic(first, "Klinika e Kopjes");
    const besnik = await newDentist(first, c.admin);
    const patient = (await c.admin.post("/api/patients", { fullName: SECRETS.name, phone: SECRETS.phone, email: SECRETS.email, birthDate: "1988-02-29", note: SECRETS.note, dentistId: besnik.id })).data.patient;
    const visit = (await besnik.client.post("/api/appointments", { dentistId: besnik.id, serviceId: c.checkup.id, startsAt: "2026-10-12T09:00:00.000Z", patientId: patient.id })).data.id as number;
    first.setNow("2026-10-12T10:00:00Z");
    await besnik.client.put(`/api/appointments/${visit}/report`, { workDone: "Mbushje në dhëmbin 26.", nextVisitDays: 30 });
    await besnik.client.put(`/api/appointments/${visit}/report`, { workDone: "Mbushje në dhëmbin 27 (jo 26).", nextVisitDays: 30 });
    const online = await client(first.base).post(`/api/public/clinics/${c.clinic.slug}/book`, { serviceId: c.checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput({ email: "online@example.test" }) });
    const toCancel = (await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt: "2026-10-15T07:00:00.000Z", newPatient: { fullName: "Për Anulim", email: "anulim@example.test" } })).data.id as number;
    await c.admin.post(`/api/appointments/${toCancel}/cancel`, { reason: "Defekt i pajisjes" });
    await c.admin.post(`/api/staff/${besnik.id}/time-off`, { startsAt: "2026-11-02T08:00:00Z", endsAt: "2026-11-03T08:00:00Z" });
    // A request that looks for the patient by name, one that carries the private link, a failed login.
    await c.admin.get(`/api/patients?q=${encodeURIComponent("Zana")}`);
    await client(first.base).get("/api/public/appointment", { "x-appointment-token": online.data.token });
    await client(first.base).post("/api/auth/login", { email: c.email, password: SECRETS.password });

    const exported = await exportBackup(first.ctx.db, first.ctx.now());
    // Through text and back, as the file on disk would be.
    backup = parseBackup(JSON.stringify(exported));
    source = { logs: first.logs, token: online.data.token as string, adminEmail: c.email, patientId: patient.id, counts: Object.fromEntries(BACKED_UP.map((t) => [t, exported.tables[t]!.length])) };
    await first.close();

    // ---- the empty database it is restored into ----
    app = await startApp("2026-10-12T10:00:00Z");
  });
  afterAll(() => app?.close());

  it("covers every table that holds records, and says which it leaves out", async () => {
    const tables = (await app.ctx.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")).map((r) => r.table_name);
    // A table added by a later migration must be put on one list or the other, or this fails.
    expect(tables.sort()).toEqual([...BACKED_UP, ...NOT_BACKED_UP].sort());
    expect(source.counts).toMatchObject({ clinics: 1, users: 2, visit_reports: 1, visit_report_versions: 2 });
    expect(source.counts.patients).toBe(3);
    expect(source.counts.appointments).toBe(3);
    expect(source.counts.email_log).toBeGreaterThanOrEqual(3);
    expect(source.counts.audit_log).toBeGreaterThanOrEqual(5);
  });

  it("refuses what is not a backup, a backup of another schema version, and a database that is not empty", async () => {
    expect(() => parseBackup("jo json")).toThrow(BackupError);
    expect(() => parseBackup(JSON.stringify({ app: "tjeter", format: 1 }))).toThrow(BackupError);
    expect(() => parseBackup(JSON.stringify({ ...backup, tables: { ...backup.tables, patients: undefined } }))).toThrow(/patients/);
    await expect(restoreBackup(app.ctx.db, { ...backup, schemaVersion: backup.schemaVersion + 1 })).rejects.toThrow(/newer version/);
    await expect(restoreBackup(app.ctx.db, { ...backup, schemaVersion: backup.schemaVersion - 1 })).rejects.toThrow(/application version that made it/);
    expect(await app.ctx.db.query("SELECT 1 FROM clinics")).toHaveLength(0);
  });

  it("restores every record exactly, all or nothing", async () => {
    // A backup damaged in its last table: nothing of it may stay behind.
    const damaged = { ...backup, tables: { ...backup.tables, audit_log: [{ id: 1, clinic_id: 999999, action: "x", entity: "y" }] } };
    await expect(restoreBackup(app.ctx.db, damaged)).rejects.toThrow();
    expect(await app.ctx.db.query("SELECT 1 FROM clinics")).toHaveLength(0);
    expect(await app.ctx.db.query("SELECT 1 FROM patients")).toHaveLength(0);

    expect(await restoreBackup(app.ctx.db, backup)).toEqual(source.counts);
    const again = await exportBackup(app.ctx.db, app.ctx.now());
    expect(sameContent(backup, again)).toEqual({ same: true });
    // Spot checks of the kinds of value that conversions like to bend: a date, an instant, a flag, JSON.
    expect(await app.ctx.db.query("SELECT to_char(birth_date, 'YYYY-MM-DD') AS d, note FROM patients WHERE id = $1", [source.patientId])).toEqual([{ d: "1988-02-29", note: SECRETS.note }]);
    const cancelled = await app.ctx.db.query<{ starts_at: Date; cancel_reason: string }>("SELECT starts_at, cancel_reason FROM appointments WHERE status = 'cancelled'");
    expect(cancelled.map((r) => [new Date(r.starts_at).toISOString(), r.cancel_reason])).toEqual([["2026-10-15T07:00:00.000Z", "Defekt i pajisjes"]]);
    expect((await app.ctx.db.query<{ meta: { version: number } }>("SELECT meta FROM audit_log WHERE action = 'report_edited'"))[0]!.meta).toEqual({ version: 2 });

    // A database that grew through migrations lists a table's columns in another order than a fresh one.
    // The same records in another field order are the same records; a changed value is not.
    const reordered = { ...backup, tables: { ...backup.tables, patients: backup.tables.patients!.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).reverse())) } };
    expect(sameContent(backup, reordered)).toEqual({ same: true });
    const changed = { ...backup, tables: { ...backup.tables, patients: backup.tables.patients!.map((row, i) => (i === 0 ? { ...(row as Record<string, unknown>), note: "tjetër" } : row)) } };
    expect(sameContent(backup, changed)).toEqual({ same: false, firstDifference: "patients: row 1 differs in note" });

    // The same moment written in another timezone, or with fewer trailing zeros, is the same moment;
    // a moment one microsecond later is not.
    const stamped = (value: string) => ({ ...backup, tables: { ...backup.tables, clinics: [{ ...(backup.tables.clinics![0] as Record<string, unknown>), created_at: value }] } });
    expect(sameContent(stamped("2026-10-11T00:31:32.536855+00:00"), stamped("2026-10-11T01:31:32.536855+01:00"))).toEqual({ same: true });
    expect(sameContent(stamped("2026-10-11T00:31:32.5+00:00"), stamped("2026-10-10T19:31:32.500000-05"))).toEqual({ same: true });
    expect(sameContent(stamped("2026-10-11T00:31:32.536855+00:00"), stamped("2026-10-11T00:31:32.536856+00:00"))).toEqual({ same: false, firstDifference: "clinics: row 1 differs in created_at" });
    // Text that merely LOOKS like a moment is text. Two notes, two cancellation reasons, two report texts
    // that name the same moment in different timezones are different texts, and are reported as different.
    const withText = (table: string, column: string, value: string) => ({ ...backup, tables: { ...backup.tables, [table]: backup.tables[table]!.map((row, i) => (i === 0 ? { ...(row as Record<string, unknown>), [column]: value } : row)) } });
    for (const [table, column] of [["patients", "note"], ["appointments", "cancel_reason"], ["visit_reports", "work_done"], ["email_log", "body"], ["clinics", "name"]] as const) {
      expect(sameContent(withText(table, column, "2026-10-11T00:31:32.536855+00:00"), withText(table, column, "2026-10-11T01:31:32.536855+01:00"))).toEqual({ same: false, firstDifference: `${table}: row 1 differs in ${column}` });
    }
    // A field that one record has and the other lacks is a difference too.
    const without = { ...backup, tables: { ...backup.tables, patients: backup.tables.patients!.map((row, i) => (i === 0 ? Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([k]) => k !== "note")) : row)) } };
    expect(sameContent(backup, without)).toEqual({ same: false, firstDifference: "patients: row 1 differs in note" });
    // The columns treated as moments are exactly the database's timestamp columns: none missing, none extra.
    const real = await app.ctx.db.query<{ table_name: string; column_name: string }>("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'timestamp with time zone' ORDER BY 1, 2");
    for (const table of BACKED_UP) {
      expect([table, [...INSTANT_COLUMNS[table]!].sort()]).toEqual([table, real.filter((c) => c.table_name === table).map((c) => c.column_name)]);
    }
    // And every instant in a backup is written in UTC to begin with.
    expect(JSON.stringify(again.tables).match(/T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}"/g)!.every((t) => t.endsWith('+00:00"'))).toBe(true);

    // And a second restore on top of it is refused.
    await expect(restoreBackup(app.ctx.db, backup)).rejects.toThrow(/not empty/);
  });

  it("the restored clinic works: people log in with their passwords, history is there, new records get new ids", async () => {
    const admin = client(app.base);
    // Nobody is logged in after a restore.
    expect((await admin.get("/api/auth/me")).status).toBe(401);
    expect((await admin.post("/api/auth/login", { email: source.adminEmail, password: "fjalekalimi1" })).status).toBe(200);
    const record = (await admin.get(`/api/patients/${source.patientId}`)).data;
    expect(record.patient).toMatchObject({ fullName: SECRETS.name, birthDate: "1988-02-29" });
    expect(record.visits[0]).toMatchObject({ workDone: "Mbushje në dhëmbin 27 (jo 26).", nextVisitDays: 30 });
    // The private link of the patient who booked online still opens their appointment.
    expect((await client(app.base).get("/api/public/appointment", { "x-appointment-token": source.token })).status).toBe(200);
    // The counters continue after the highest restored id instead of colliding with it.
    const highest = (await app.ctx.db.query<{ m: number }>("SELECT max(id)::int AS m FROM patients"))[0]!.m;
    const created = await admin.post("/api/patients", { fullName: "Pacient i Ri" });
    expect(created.status).toBe(201);
    expect(created.data.patient.id).toBe(highest + 1);
    // The rule that guards the last administrator came along with the schema.
    await expect(app.ctx.db.query("UPDATE users SET is_active = FALSE WHERE role = 'admin'")).rejects.toMatchObject({ code: "TD001" });
  });

  describe("migrations", () => {
    const extra = (version: number, name: string, sql: string): Migration => ({ version, name, sql, checksum: `test-${version}-${sql.length}` });
    const two = extra(2, "provë_e_dytë".replace(/[^a-z_]/g, "x"), "CREATE TABLE prove_dy (id INTEGER PRIMARY KEY); INSERT INTO prove_dy VALUES (1);");

    it("a new database is at the latest version, and opening it again applies nothing", async () => {
      const real = loadMigrations();
      expect(real[0]).toMatchObject({ version: 1, name: "baseline" });
      expect(await schemaVersion(app.ctx.db)).toBe(real.length);
      expect(await app.ctx.db.migrate()).toEqual({ applied: [], current: real.length });
    });

    it("every table refuses every role but the application's own", async () => {
      const db = app.ctx.db;
      // No table may be left open: one added later without row-level security fails here.
      const open = await db.query<{ relname: string }>("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r' AND NOT c.relrowsecurity");
      expect(open.map((r) => r.relname)).toEqual([]);
      // Another role, even one that has been GRANTED the tables (as a hosted database's web API role is),
      // sees no rows and can add none. The application, as owner, sees everything.
      // A role name of its own per run: roles belong to the whole server, not to this test's database.
      const visitor = `vizitor_i_huaj_${Date.now()}`;
      await db.query(`CREATE ROLE ${visitor}`);
      try {
      // On a hosted server the application is not a superuser: it may act as another role only as a member.
      await db.query(`GRANT ${visitor} TO CURRENT_USER`);
      await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${visitor}`);
      const seen = await db.tx(async (q) => {
        await q.query(`SET LOCAL ROLE ${visitor}`);
        const patients = await q.query("SELECT 1 FROM patients");
        const staff = await q.query("SELECT 1 FROM users");
        const reports = await q.query("SELECT 1 FROM visit_reports");
        const touched = await q.query("UPDATE patients SET note = 'ndryshuar nga jashtë' RETURNING id");
        return { patients: patients.length, staff: staff.length, reports: reports.length, touched: touched.length };
      });
      expect(seen).toEqual({ patients: 0, staff: 0, reports: 0, touched: 0 });
      await expect(
        db.tx(async (q) => {
          await q.query(`SET LOCAL ROLE ${visitor}`);
          await q.query("INSERT INTO services (clinic_id, name, duration_minutes) SELECT id, 'nga jashtë', 30 FROM clinics LIMIT 1");
          await q.query("INSERT INTO email_log (clinic_id, to_email, kind, subject, body, status) VALUES (1, 'x@example.test', 'reminder', 's', 'b', 'stored')");
        }),
      ).rejects.toThrow(/row-level security/);
      expect((await db.query("SELECT 1 FROM patients")).length).toBeGreaterThan(0);
      expect(await db.query("SELECT 1 FROM patients WHERE note = 'ndryshuar nga jashtë'")).toHaveLength(0);
      } finally {
        await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${visitor}`).catch(() => {});
        await db.query(`DROP ROLE IF EXISTS ${visitor}`).catch(() => {});
      }
    });

    it("applies a new migration once, in its own transaction, and leaves the data as it was", async () => {
      const real = loadMigrations();
      const before = await exportBackup(app.ctx.db, app.ctx.now());
      expect((await app.ctx.db.migrate([...real, { ...two, version: real.length + 1 }])).applied).toEqual([{ version: real.length + 1, name: two.name }]);
      expect((await app.ctx.db.migrate([...real, { ...two, version: real.length + 1 }])).applied).toEqual([]);
      expect(await app.ctx.db.query("SELECT id FROM prove_dy")).toEqual([{ id: 1 }]);
      expect(sameContent(before, { ...(await exportBackup(app.ctx.db, app.ctx.now())), schemaVersion: before.schemaVersion })).toEqual({ same: true });
    });

    it("a migration that fails halfway leaves nothing behind and the version where it was", async () => {
      const real = loadMigrations();
      const applied = [...real, { ...two, version: real.length + 1 }];
      const broken = extra(real.length + 2, "e_prishur", "CREATE TABLE prove_tre (id INTEGER); INSERT INTO nuk_ekziston VALUES (1);");
      await expect(app.ctx.db.migrate([...applied, broken])).rejects.toThrow();
      expect(await app.ctx.db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'prove_tre'")).toHaveLength(0);
      expect(await schemaVersion(app.ctx.db)).toBe(real.length + 1);
    });

    it("refuses to start on a database that a newer version has used, or whose applied migration was edited", async () => {
      const real = loadMigrations();
      // The code knows fewer migrations than the database has: the application was downgraded.
      await expect(app.ctx.db.migrate(real)).rejects.toThrow(MigrationError);
      await expect(app.ctx.db.migrate(real)).rejects.toThrow(/newer version/);
      // Someone edited a migration after it ran.
      const edited = { ...two, version: real.length + 1, checksum: "ndryshe" };
      await expect(app.ctx.db.migrate([...real, edited])).rejects.toThrow(/changed after it was applied/);
    });

    it("reads migration files strictly: numbered without gaps, named plainly, the same on Windows and Linux", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "termini-migrations-"));
      try {
        writeFileSync(path.join(dir, "001_a.sql"), "SELECT 1;\nSELECT 2;\n");
        const unix = loadMigrations(dir)[0]!.checksum;
        writeFileSync(path.join(dir, "001_a.sql"), "SELECT 1;\r\nSELECT 2;\r\n");
        expect(loadMigrations(dir)[0]!.checksum).toBe(unix);
        writeFileSync(path.join(dir, "003_c.sql"), "SELECT 3;");
        expect(() => loadMigrations(dir)).toThrow(/without gaps/);
        rmSync(path.join(dir, "003_c.sql"));
        writeFileSync(path.join(dir, "2-second.sql"), "SELECT 2;");
        expect(() => loadMigrations(dir)).toThrow(/NNN_short_name/);
        mkdirSync(path.join(dir, "notes"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("what the server writes to its log", () => {
    it("is one JSON object per line, names requests by their route pattern, and holds no patient data", () => {
      const lines = source.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.length).toBeGreaterThan(10);
      for (const line of lines) expect(line).toMatchObject({ event: "request", time: expect.any(String), level: expect.any(String), method: expect.any(String), status: expect.any(Number), ms: expect.any(Number), requestId: expect.any(String) });
      const routes = new Set(lines.map((l) => l.route));
      expect(routes).toContain("/api/public/appointment");
      expect(routes).toContain("/api/patients");
      expect(routes).toContain("/api/appointments/:id/report");
      // Who did it is there as numbers...
      expect(lines.some((l) => typeof l.userId === "number" && typeof l.clinicId === "number")).toBe(true);
      // ...and nothing a patient or a member of staff would recognise as theirs.
      const all = source.logs.join("\n");
      for (const secret of [source.token, SECRETS.name, "Zana", SECRETS.email, "online@example.test", "044987654", SECRETS.phone, SECRETS.note, SECRETS.password, "fjalekalimi1", "Mbushje", "Defekt i pajisjes", source.adminEmail, "?q=", "Klinika e Kopjes"]) {
        expect(all).not.toContain(secret);
      }
    });

    it("logs a request that failed too, still without its address", async () => {
      const before = app.logs.length;
      expect((await client(app.base).get("/api/public/appointment", { "x-appointment-token": "link-i-vdekur-sekret" })).status).toBe(404);
      expect((await client(app.base).get("/api/nuk-ka-rruge/Zana-Sekreti")).status).toBe(404);
      const lines = app.logs.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.map((l) => [l.route, l.status])).toEqual([
        ["/api/public/appointment", 404],
        ["/api/(unmatched)", 404],
      ]);
      expect(app.logs.slice(before).join("\n")).not.toMatch(/link-i-vdekur|Zana/);
    });

    it("reports an unexpected failure by its kind and a request id, never by the database's own words", async () => {
      const admin = client(app.base);
      await admin.post("/api/auth/login", { email: source.adminEmail, password: "fjalekalimi1" });
      const real = app.ctx.db.query;
      // What PostgreSQL says on a duplicate key: the value itself is in the text.
      const leak = Object.assign(new Error(`duplicate key value violates unique constraint "users_email_key"`), { code: "23505", detail: `Key (email)=(${SECRETS.email}) already exists.` });
      const before = app.logs.length;
      app.ctx.db.query = ((sql: string, params?: unknown[]) => (sql.includes("FROM patients p") ? Promise.reject(leak) : real(sql, params))) as typeof real;
      let res;
      try {
        res = await admin.get("/api/patients");
      } finally {
        app.ctx.db.query = real;
      }
      expect(res.status).toBe(500);
      expect(res.data.error).not.toContain("duplicate");
      expect(res.data.requestId).toMatch(/^[0-9a-f]{8}$/);
      const written = app.logs.slice(before).join("\n");
      const line = app.logs.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "unexpected_error")!;
      expect(line).toMatchObject({ level: "error", requestId: res.data.requestId, errorType: "Error", errorCode: "23505" });
      expect(written).not.toContain(SECRETS.email);
      expect(written).not.toContain("duplicate key");
      expect(written).not.toContain("users_email_key");
    });

    it("keeps to its level, and prints only an error's class, code and our own source lines", () => {
      const out: string[] = [];
      const log = createLogger({ level: "warn", write: (line) => out.push(line), now: () => new Date("2026-10-12T08:00:00Z") });
      log.info("jo", {});
      log.debug("jo", {});
      log.warn("po", { n: 1 });
      expect(out).toEqual([`{"time":"2026-10-12T08:00:00.000Z","level":"warn","event":"po","n":1}`]);
      const shown = safeError(Object.assign(new Error(`550 5.1.1 <${SECRETS.email}>: Recipient address rejected`), { code: "EENVELOPE" }));
      expect(shown).toMatchObject({ errorType: "Error", errorCode: "EENVELOPE" });
      expect(JSON.stringify(shown)).not.toContain(SECRETS.email);
      expect(JSON.stringify(shown)).not.toContain("Recipient");
      expect(safeError("vetëm tekst")).toEqual({ errorType: "string" });
    });
  });
});

describe("configuration, checked at start", () => {
  const good = { PUBLIC_URL: "https://termine.example.org", DATABASE_URL: "postgres://app:fjalekalim-baze@db.example.org:5432/termini", SMTP_HOST: "smtp.example.org", SMTP_USER: "u", SMTP_PASS: "smtp-sekret", MAIL_FROM: "Klinika <termine@klinika.example.org>", NODE_ENV: "production", TRUST_PROXY: "1" };

  it("runs on a development machine with nothing set, and says what that means", () => {
    const { config, warnings } = readConfig({});
    expect(config).toMatchObject({ production: false, port: 3101, databaseUrl: null, pgliteDir: "data/pg", publicUrl: "http://localhost:5180", smtp: null, logLevel: "info" });
    expect(warnings.join(" ")).toContain("No mail server is configured");
  });

  it("accepts a complete production setup without a word", () => {
    const { config, warnings } = readConfig(good);
    expect(warnings).toEqual([]);
    expect(config.smtp).toMatchObject({ host: "smtp.example.org", port: 587, from: "Klinika <termine@klinika.example.org>" });
    expect(config.publicUrl).toBe("https://termine.example.org");
  });

  it("stops on settings that cannot work, naming each one", () => {
    const bad = () => readConfig({ PORT: "abc", PUBLIC_URL: "termine.example.org", DATABASE_URL: "mysql://x", SMTP_HOST: "smtp.example.org", SMTP_USER: "u", MAIL_FROM: "Termini Dental <no-reply@example.com>", LOG_LEVEL: "loud" });
    expect(bad).toThrow(ConfigError);
    try {
      bad();
    } catch (err) {
      const problems = (err as ConfigError).problems.join("\n");
      for (const name of ["PORT", "PUBLIC_URL", "DATABASE_URL", "MAIL_FROM", "SMTP_USER and SMTP_PASS", "LOG_LEVEL"]) expect(problems).toContain(name);
    }
    expect(() => readConfig({ SMTP_HOST: "smtp.example.org" })).toThrow(/MAIL_FROM must be set/);
    expect(() => readConfig({ PUBLIC_URL: "https://termine.example.org/klinika" })).toThrow(/without a path/);
  });

  it("reads the proxy switch as yes or no, so that 'false' can never turn it on", () => {
    for (const on of ["1", "true", "TRUE", "yes"]) expect(readConfig({ TRUST_PROXY: on }).config.trustProxy).toBe(true);
    for (const off of ["", "0", "false", "False", "no", undefined]) expect(readConfig({ TRUST_PROXY: off }).config.trustProxy).toBe(false);
    expect(() => readConfig({ TRUST_PROXY: "2" })).toThrow(/TRUST_PROXY must be 1/);
    expect(() => readConfig({ TRUST_PROXY: "proxy.example.org" })).toThrow(ConfigError);
  });

  it("warns about what would run but hurt in production", () => {
    const { warnings } = readConfig({ NODE_ENV: "production", PUBLIC_URL: "http://localhost:5180" });
    const text = warnings.join("\n");
    for (const part of ["not https", "points at this machine", "DATABASE_URL is not set", "TRUST_PROXY is not set", "No mail server"]) expect(text).toContain(part);
  });

  it("describes itself without a single secret", () => {
    const shown = JSON.stringify(describeConfig(readConfig(good).config));
    for (const secret of ["fjalekalim-baze", "smtp-sekret", "app:", "termine@klinika.example.org"]) expect(shown).not.toContain(secret);
    expect(shown).toContain("db.example.org");
    // And a configuration error does not echo the connection string either.
    try {
      readConfig({ DATABASE_URL: "mysql://user:tjeter-sekret@host/db" });
    } catch (err) {
      expect((err as Error).message).not.toContain("tjeter-sekret");
    }
  });
});
