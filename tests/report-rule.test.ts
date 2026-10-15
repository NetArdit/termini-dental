import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportBackup, restoreBackup } from "../src/server/backup";
import { COMPLETED_WITHOUT_REPORT, NO_SHOW_WITH_REPORT, loadMigrations, pgErrorCode } from "../src/server/db";
import { newClinic, newDentist, startApp, type TestApp } from "./helpers";

// Owner's rule 6: every visit that took place has a written report. A visit is "completed" only when its
// report exists, and that is held by the database, not only by the routes (audit H5).

const NOW = "2026-10-12T08:00:00Z";
const MON_0900 = "2026-10-12T07:00:00.000Z";
const AFTER = "2026-10-12T12:40:00Z";

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
beforeEach(() => app.setNow(NOW));

type Clinic = Awaited<ReturnType<typeof newClinic>>;
async function visit(c: Clinic, startsAt = MON_0900) {
  // Made a little earlier, for a time that is then in the past.
  app.setNow("2026-10-12T06:00:00Z");
  const made = await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt, newPatient: { fullName: "Pacient Provë", phone: "044 111 222" } });
  expect(made.status).toBe(201);
  app.setNow(AFTER);
  return made.data.id as number;
}
const statusOf = async (id: number) => (await app.ctx.db.query<{ status: string }>("SELECT status FROM appointments WHERE id = $1", [id]))[0]!.status;
const refusedByTheRule = async (work: Promise<unknown>) => {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the database let it through").not.toBeNull();
  expect(pgErrorCode(err)).toBe(COMPLETED_WITHOUT_REPORT);
};

describe("a visit is completed only with its report", () => {
  it("cannot be marked completed through the application while it has no report, and says what to do", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    const res = await c.admin.post(`/api/appointments/${id}/status`, { status: "completed" });
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/raporti/);
    expect(await statusOf(id)).toBe("booked");
    expect((await app.ctx.db.query("SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'appointment_status_changed'", [id])).length).toBe(0);
    // The other marks still work.
    expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "no_show" })).status).toBe(200);
    expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "booked" })).status).toBe(200);
  });

  it("saving the report completes the visit, in one step; editing the report keeps it completed and keeps every version", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    const saved = await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Mbushje në dhëmbin 26.", nextVisitDays: 180 });
    expect(saved.status).toBe(200);
    expect(saved.data.version).toBe(1);
    expect(await statusOf(id)).toBe("completed");
    const edited = await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Mbushje në dhëmbin 26. Kontroll pas 6 muajsh." });
    expect(edited.data.version).toBe(2);
    expect(await statusOf(id)).toBe("completed");
    expect((await app.ctx.db.query("SELECT 1 FROM visit_report_versions WHERE appointment_id = $1", [id])).length).toBe(2);
  });

  it("a mark taken off by mistake can be put back, because the report is there", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Pastrim i gurëzave." });
    expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "booked" })).status).toBe(200);
    expect(await statusOf(id)).toBe("booked");
    expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "completed" })).status).toBe(200);
    expect(await statusOf(id)).toBe("completed");
  });

  it("a report is still not written before the day of the visit, and never for a cancelled appointment", async () => {
    const c = await newClinic(app);
    app.setNow(NOW);
    const future = (await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt: "2026-10-14T07:00:00.000Z", newPatient: { fullName: "Pacient i Ardhshëm" } })).data.id as number;
    expect((await c.admin.put(`/api/appointments/${future}/report`, { workDone: "Shumë herët." })).status).toBe(409);
    expect((await c.admin.post(`/api/appointments/${future}/status`, { status: "completed" })).status).toBe(409);
    await c.admin.post(`/api/appointments/${future}/cancel`, { reason: "Ndryshim" });
    expect((await c.admin.put(`/api/appointments/${future}/report`, { workDone: "I anuluar." })).status).toBe(409);
    expect(await statusOf(future)).toBe("cancelled");
  });

  it("a colleague who may not open the visit can neither mark it nor write its report", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const id = await visit(c);
    expect((await besnik.client.post(`/api/appointments/${id}/status`, { status: "completed" })).status).toBe(404);
    expect((await besnik.client.put(`/api/appointments/${id}/report`, { workDone: "Jo i imi." })).status).toBe(404);
    expect(await statusOf(id)).toBe("booked");
  });
});

describe("a visit with a report was attended", () => {
  it("cannot be marked 'did not come' while it has a report; 'booked' still undoes a mistaken mark", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Kontroll." });
    const res = await c.admin.post(`/api/appointments/${id}/status`, { status: "no_show" });
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/ka raport/);
    expect(await statusOf(id)).toBe("completed");
    expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "booked" })).status).toBe(200);
    expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "no_show" })).status).toBe(409);
    expect(await statusOf(id)).toBe("booked");
  });

  it("writing the report of a visit that was marked 'did not come' says the patient came", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    expect((await c.admin.post(`/api/appointments/${id}/status`, { status: "no_show" })).status).toBe(200);
    expect((await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Erdhi më vonë. Kontroll." })).status).toBe(200);
    expect(await statusOf(id)).toBe("completed");
  });

  it("the database refuses the contradiction by direct SQL, from either side", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Kontroll." });
    const refusedAs = async (code: string, work: Promise<unknown>) => expect(pgErrorCode(await work.then(() => null, (e: unknown) => e))).toBe(code);
    await refusedAs(NO_SHOW_WITH_REPORT, app.ctx.db.query("UPDATE appointments SET status = 'no_show' WHERE id = $1", [id]));
    const other = await visit(c, "2026-10-12T08:00:00.000Z");
    await app.ctx.db.query("UPDATE appointments SET status = 'no_show' WHERE id = $1", [other]);
    await refusedAs(NO_SHOW_WITH_REPORT, app.ctx.db.query("INSERT INTO visit_reports (appointment_id, work_done, author_id) VALUES ($1, 'Nuk përputhet.', $2)", [other, c.adminId]));
    expect((await app.ctx.db.query("SELECT 1 FROM visit_reports WHERE appointment_id = $1", [other])).length).toBe(0);
  });
});

describe("the database holds the rule, whoever writes", () => {
  it("refuses 'completed' without a report by direct SQL, as an update and as a new row", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await refusedByTheRule(app.ctx.db.query("UPDATE appointments SET status = 'completed' WHERE id = $1", [id]));
    expect(await statusOf(id)).toBe("booked");
    const row = (await app.ctx.db.query<{ patient_id: number }>("SELECT patient_id FROM appointments WHERE id = $1", [id]))[0]!;
    await refusedByTheRule(
      app.ctx.db.query(
        "INSERT INTO appointments (clinic_id, dentist_id, patient_id, service_id, starts_at, ends_at, status, source) VALUES ($1, $2, $3, $4, '2026-10-09T07:00:00Z', '2026-10-09T07:30:00Z', 'completed', 'local')",
        [c.clinic.id, c.adminId, row.patient_id, c.checkup.id],
      ),
    );
    expect((await app.ctx.db.query("SELECT 1 FROM appointments WHERE clinic_id = $1", [c.clinic.id])).length).toBe(1);
  });

  it("refuses to delete the report of a completed visit, and lets it go once the visit is no longer completed", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Nxjerrje e dhëmbit 48." });
    await refusedByTheRule(app.ctx.db.query("DELETE FROM visit_reports WHERE appointment_id = $1", [id]));
    expect((await app.ctx.db.query("SELECT 1 FROM visit_reports WHERE appointment_id = $1", [id])).length).toBe(1);
    await app.ctx.db.tx(async (q) => {
      await q.query("UPDATE appointments SET status = 'booked' WHERE id = $1", [id]);
      await q.query("DELETE FROM visit_reports WHERE appointment_id = $1", [id]);
    });
    expect(await statusOf(id)).toBe("booked");
  });

  it("judges at the end of the transaction: the mark first and the report after it is fine, the mark alone is undone whole", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await app.ctx.db.tx(async (q) => {
      await q.query("UPDATE appointments SET status = 'completed' WHERE id = $1", [id]);
      await q.query("INSERT INTO visit_reports (appointment_id, work_done, author_id) VALUES ($1, 'Kontroll.', $2)", [id, c.adminId]);
    });
    expect(await statusOf(id)).toBe("completed");

    const other = await visit(c, "2026-10-12T08:00:00.000Z");
    await refusedByTheRule(
      app.ctx.db.tx(async (q) => {
        await q.query("UPDATE patients SET note = 'ndryshuar në të njëjtin transaksion' WHERE id = (SELECT patient_id FROM appointments WHERE id = $1)", [other]);
        await q.query("UPDATE appointments SET status = 'completed' WHERE id = $1", [other]);
      }),
    );
    expect(await statusOf(other)).toBe("booked");
    expect((await app.ctx.db.query<{ note: string | null }>("SELECT note FROM patients WHERE id = (SELECT patient_id FROM appointments WHERE id = $1)", [other]))[0]!.note).toBeNull();
  });

  it("removing an appointment removes its report with it, and a patient with theirs", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Kontroll." });
    await app.ctx.db.query("DELETE FROM appointments WHERE id = $1", [id]);
    expect((await app.ctx.db.query("SELECT 1 FROM visit_reports WHERE appointment_id = $1", [id])).length).toBe(0);
  });

  it("a backup with completed visits goes back in, although it writes the appointments before their reports", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Mbushje." });
    const backup = await exportBackup(app.ctx.db, app.ctx.now());
    const second = await startApp(AFTER);
    try {
      await restoreBackup(second.ctx.db, JSON.parse(JSON.stringify(backup)));
      expect((await second.ctx.db.query<{ status: string }>("SELECT status FROM appointments WHERE id = $1", [id]))[0]!.status).toBe("completed");
      // A backup that was tampered with, a completed visit without its report, is refused whole.
      const third = await startApp(AFTER);
      try {
        const broken = JSON.parse(JSON.stringify(backup));
        broken.tables.visit_reports = [];
        broken.tables.visit_report_versions = [];
        await expect(restoreBackup(third.ctx.db, broken)).rejects.toThrow();
        expect((await third.ctx.db.query("SELECT 1 FROM appointments")).length).toBe(0);
      } finally {
        await third.close();
      }
    } finally {
      await second.close();
    }
  });
});

describe("a database that already breaks the rule", () => {
  it("is not migrated: nothing is invented and nothing is changed, and the message names the visits", async () => {
    const old = await startApp(NOW);
    try {
      const c = await newClinic(old);
      old.setNow("2026-10-12T06:00:00Z");
      const ids: number[] = [];
      for (const startsAt of [MON_0900, "2026-10-12T08:00:00.000Z"]) {
        ids.push((await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt, newPatient: { fullName: "Pacient i Vjetër", phone: "044 000 111" } })).data.id as number);
      }
      const db = old.ctx.db;
      // As the database stood before migration 007: no rule, and two visits marked completed with one press.
      for (const sql of [
        "DROP TRIGGER appointments_completed_needs_a_report ON appointments",
        "DROP TRIGGER visit_reports_stay_with_completed ON visit_reports",
        "DROP TRIGGER visit_reports_not_for_no_show ON visit_reports",
        "DROP FUNCTION completed_needs_a_report()",
        "DELETE FROM schema_migrations WHERE version >= 7",
        "DROP TABLE password_resets",
        "UPDATE appointments SET status = 'completed'",
      ]) await db.query(sql);
      const picture = async () => JSON.stringify([await db.query("SELECT id, status FROM appointments ORDER BY id"), await db.query("SELECT * FROM visit_reports"), await db.query("SELECT version FROM schema_migrations ORDER BY version")]);
      const before = await picture();
      await expect(db.migrate()).rejects.toThrow(new RegExp(`2 appointment\\(s\\) are marked completed without a visit report \\(ids: ${ids[0]}, ${ids[1]}\\)`));
      expect(await picture()).toBe(before);

      // A person settles each: one did happen and gets its report, the other is set back.
      await db.query("INSERT INTO visit_reports (appointment_id, work_done, author_id) VALUES ($1, 'Kontroll, shkruar më vonë.', $2)", [ids[0], c.adminId]);
      await db.query("UPDATE appointments SET status = 'no_show' WHERE id = $1", [ids[1]]);
      // One more thing the old application allowed: "did not come" beside a report. Also not converted.
      await db.query("INSERT INTO visit_reports (appointment_id, work_done, author_id) VALUES ($1, 'Raport pranë një mungese.', $2)", [ids[1], c.adminId]);
      const contradiction = await picture();
      await expect(db.migrate()).rejects.toThrow(new RegExp(`1 appointment\\(s\\) are marked no_show although they have a visit report \\(ids: ${ids[1]}\\)`));
      expect(await picture()).toBe(contradiction);
      await db.query("DELETE FROM visit_reports WHERE appointment_id = $1", [ids[1]]);
      // 007 and every migration after it, which had been taken off with it.
      expect((await db.migrate()).applied.map((m) => m.version)).toEqual(loadMigrations().map((m) => m.version).filter((v) => v >= 7));
      expect((await db.query<{ status: string }>("SELECT status FROM appointments ORDER BY id")).map((r) => r.status)).toEqual(["completed", "no_show"]);
      expect((await db.migrate()).applied).toEqual([]);
    } finally {
      await old.close();
    }
  });
});
