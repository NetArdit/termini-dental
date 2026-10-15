import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { retryPendingEmails } from "../src/server/mail";
import { client, newClinic, patientInput, startApp, type TestApp } from "./helpers";

// A cancellation and the message that tells the patient about it are stored together or not at all, and the
// mail server is spoken to only afterwards (audit H2). Owner's rule 3: a patient whose appointment is
// cancelled is told, and the clinic can see whether they were.

const NOW = "2026-10-12T08:00:00Z";
const WED_0900 = "2026-10-14T07:00:00.000Z";

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
beforeEach(() => {
  app.setNow(NOW);
  app.ctx.maxBookingsPerHour = 1000;
  app.failMail.value = false;
});

const pub = () => client(app.base);
const one = async <T>(sql: string, params: unknown[]) => (await app.ctx.db.query<T>(sql, params))[0]!;
const mails = (clinicId: number, kind: string) => app.ctx.db.query<{ id: number; status: string; attempts: number; to_email: string }>("SELECT id, status, attempts, to_email FROM email_log WHERE clinic_id = $1 AND kind = $2 ORDER BY id", [clinicId, kind]);
const audits = (clinicId: number, action: string) => app.ctx.db.query("SELECT 1 FROM audit_log WHERE clinic_id = $1 AND action = $2", [clinicId, action]);

async function staffBooking(c: Awaited<ReturnType<typeof newClinic>>, email: string | null = `pacient-${Math.floor(Math.random() * 1e9)}@example.test`) {
  const made = await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt: WED_0900, newPatient: { fullName: "Pacient Provë", phone: "044 111 222", ...(email ? { email } : {}) } });
  expect(made.status).toBe(201);
  return { id: made.data.id as number, email };
}
async function onlineBooking(c: Awaited<ReturnType<typeof newClinic>>) {
  const who = patientInput();
  const res = await pub().post("/api/public/book", { serviceId: c.checkup.id, dentistId: null, startsAt: WED_0900, ...who });
  expect(res.status).toBe(201);
  const id = (await one<{ id: number }>("SELECT id FROM appointments WHERE clinic_id = $1 ORDER BY id DESC LIMIT 1", [c.clinic.id])).id;
  return { id, token: res.data.token as string, who };
}

describe("a cancellation by the clinic", () => {
  it("is stored with its audit line and its message, and the message goes out after that", async () => {
    const c = await newClinic(app);
    const { id, email } = await staffBooking(c);
    const before = app.sent.length;
    const res = await c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Stomatologu mungon" });
    expect(res.status).toBe(200);
    expect(res.data.emailStatus).toBe("accepted");
    expect((await one<{ status: string }>("SELECT status FROM appointments WHERE id = $1", [id])).status).toBe("cancelled");
    expect(await audits(c.clinic.id, "appointment_cancelled_by_clinic")).toHaveLength(1);
    expect((await mails(c.clinic.id, "cancelled_by_clinic")).map((m) => [m.status, m.attempts, m.to_email])).toEqual([["accepted", 1, email]]);
    expect(app.sent.slice(before).filter((m) => m.to === email && m.subject.includes("u anulua"))).toHaveLength(1);
  });

  it("when the message cannot be written down, nothing is cancelled: the appointment stands and its link works", async () => {
    const c = await newClinic(app);
    const { id, token } = await onlineBooking(c);
    await app.ctx.db.query("ALTER TABLE email_log RENAME TO email_log_away");
    const res = await c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" });
    await app.ctx.db.query("ALTER TABLE email_log_away RENAME TO email_log");
    expect(res.status).toBe(500);
    expect((await one<{ status: string; token_hash: string | null }>("SELECT status, token_hash FROM appointments WHERE id = $1", [id])).status).toBe("booked");
    expect(await audits(c.clinic.id, "appointment_cancelled_by_clinic")).toHaveLength(0);
    expect((await pub().get("/api/public/appointment", { "x-appointment-token": token })).status).toBe(200);
    // Tried again, it goes through.
    expect((await c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" })).status).toBe(200);
    expect(await mails(c.clinic.id, "cancelled_by_clinic")).toHaveLength(1);
  });

  it("when the server stops right after the commit, the message is on record and is sent later, once", async () => {
    const c = await newClinic(app);
    const { id, email } = await staffBooking(c);
    // As a process that died between the commit and the mail server would leave it: written down, never tried.
    const mailer = app.ctx.mailer;
    app.ctx.mailer = null;
    const res = await c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Stomatologu mungon" });
    app.ctx.mailer = mailer;
    expect(res.data.emailStatus).toBe("stored");
    expect((await mails(c.clinic.id, "cancelled_by_clinic")).map((m) => [m.status, m.attempts])).toEqual([["stored", 0]]);

    const before = app.sent.length;
    expect(await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now())).toBeGreaterThanOrEqual(1);
    await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now());
    expect(app.sent.slice(before).filter((m) => m.to === email)).toHaveLength(1);
    expect((await mails(c.clinic.id, "cancelled_by_clinic"))[0]!.status).toBe("accepted");
    // The cancellation itself was never in question.
    expect((await one<{ status: string }>("SELECT status FROM appointments WHERE id = $1", [id])).status).toBe("cancelled");
  });

  it("a mail server that refuses does not undo the cancellation, and says so to the person who cancelled", async () => {
    const c = await newClinic(app);
    const { id } = await staffBooking(c);
    app.failMail.value = true;
    const res = await c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Stomatologu mungon" });
    expect(res.status).toBe(200);
    expect(res.data.emailStatus).toBe("failed");
    expect(res.data.patientPhone).toBeTruthy();
    expect((await one<{ status: string }>("SELECT status FROM appointments WHERE id = $1", [id])).status).toBe("cancelled");
    expect((await mails(c.clinic.id, "cancelled_by_clinic")).map((m) => m.status)).toEqual(["failed"]);
  });

  it("a patient without an address: cancelled, on record, and the clinic is told to phone", async () => {
    const c = await newClinic(app);
    const { id } = await staffBooking(c, null);
    const res = await c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Stomatologu mungon" });
    expect(res.data.emailStatus).toBe("no_email");
    expect(await mails(c.clinic.id, "cancelled_by_clinic")).toHaveLength(0);
    expect(await audits(c.clinic.id, "appointment_cancelled_by_clinic")).toHaveLength(1);
  });

  it("pressed twice at the same moment: one cancellation, one message", async () => {
    const c = await newClinic(app);
    const { id, email } = await staffBooking(c);
    const before = app.sent.length;
    const both = await Promise.all([c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Një" }), c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Dy" })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await mails(c.clinic.id, "cancelled_by_clinic")).toHaveLength(1);
    expect(await audits(c.clinic.id, "appointment_cancelled_by_clinic")).toHaveLength(1);
    expect(app.sent.slice(before).filter((m) => m.to === email && m.subject.includes("u anulua"))).toHaveLength(1);
  });
});

describe("a cancellation by the patient", () => {
  it("is stored with its audit line and its message; the link is dead from that moment", async () => {
    const c = await newClinic(app);
    const { id, token, who } = await onlineBooking(c);
    const res = await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": token });
    expect(res.status).toBe(200);
    expect((await one<{ status: string; token_hash: string | null; mail_token_hashes: string[] }>("SELECT status, token_hash, mail_token_hashes FROM appointments WHERE id = $1", [id]))).toEqual({ status: "cancelled", token_hash: null, mail_token_hashes: [] });
    expect(await audits(c.clinic.id, "appointment_cancelled_by_patient")).toHaveLength(1);
    expect((await mails(c.clinic.id, "cancelled_by_patient")).map((m) => [m.status, m.to_email])).toEqual([["accepted", who.email]]);
    expect((await pub().get("/api/public/appointment", { "x-appointment-token": token })).status).toBe(404);
  });

  it("when the message cannot be written down, nothing is cancelled and the patient can try again", async () => {
    const c = await newClinic(app);
    const { id, token } = await onlineBooking(c);
    await app.ctx.db.query("ALTER TABLE email_log RENAME TO email_log_away");
    const res = await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": token });
    await app.ctx.db.query("ALTER TABLE email_log_away RENAME TO email_log");
    expect(res.status).toBe(500);
    expect((await one<{ status: string }>("SELECT status FROM appointments WHERE id = $1", [id])).status).toBe("booked");
    expect(await audits(c.clinic.id, "appointment_cancelled_by_patient")).toHaveLength(0);
    expect((await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": token })).status).toBe(200);
  });

  it("a mail server that is down does not stop the patient from cancelling; the message waits and is sent later", async () => {
    const c = await newClinic(app);
    const { id, token, who } = await onlineBooking(c);
    app.failMail.value = true;
    expect((await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": token })).status).toBe(200);
    expect((await one<{ status: string }>("SELECT status FROM appointments WHERE id = $1", [id])).status).toBe("cancelled");
    app.failMail.value = false;
    app.setNow("2026-10-12T08:20:00Z");
    const before = app.sent.length;
    // Messages of other tests' clinics may be waiting too: what counts here is this patient's.
    expect(await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now())).toBeGreaterThanOrEqual(1);
    expect(app.sent.slice(before).filter((m) => m.to === who.email)).toHaveLength(1);
    expect((await mails(c.clinic.id, "cancelled_by_patient")).map((m) => m.status)).toEqual(["accepted"]);
  });

  it("sent twice at the same moment, and by the clinic at the same moment: cancelled once, told once", async () => {
    const c = await newClinic(app);
    const { id, token } = await onlineBooking(c);
    const all = await Promise.all([
      pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": token }),
      pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": token }),
      c.admin.post(`/api/appointments/${id}/cancel`, { reason: "Njëkohësisht" }),
    ]);
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(all.filter((r) => r.status >= 500)).toHaveLength(0);
    const told = [...(await mails(c.clinic.id, "cancelled_by_patient")), ...(await mails(c.clinic.id, "cancelled_by_clinic"))];
    expect(told).toHaveLength(1);
    expect([...(await audits(c.clinic.id, "appointment_cancelled_by_patient")), ...(await audits(c.clinic.id, "appointment_cancelled_by_clinic"))]).toHaveLength(1);
  });
});
