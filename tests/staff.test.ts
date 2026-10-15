import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations } from "../src/server/db";
import { queueEmail, retryPendingEmails } from "../src/server/mail";
import { composeReminder } from "../src/server/notify";
import { sendDueReminders } from "../src/server/reminders";
import { client, newClinic, newDentist, patientInput, startApp, type Client, type TestApp } from "./helpers";

// Clock: Monday 12 October 2026, 10:00 in Kosovo (08:00 UTC). See booking.test.ts.
const NOW = "2026-10-12T08:00:00Z";
const MON_1400 = "2026-10-12T12:00:00.000Z"; // today, 4 hours from now
const TUE_0900 = "2026-10-13T07:00:00.000Z"; // 23 hours from now: inside the 24-hour promise
const WED_0900 = "2026-10-14T07:00:00.000Z"; // 47 hours from now
const WED_1000 = "2026-10-14T08:00:00.000Z";

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
beforeEach(() => app.setNow(NOW));

/** Books a local patient through the staff calendar and returns the appointment id. */
async function bookLocal(c: Client, dentistId: number, serviceId: number, startsAt: string, patient: Record<string, unknown> = {}) {
  const res = await c.post("/api/appointments", {
    dentistId,
    serviceId,
    startsAt,
    newPatient: { fullName: "Mimoza Berisha", phone: "044 111 222", email: "mimoza@example.test", ...patient },
  });
  if (res.status !== 201) throw new Error("local booking failed: " + JSON.stringify(res.data));
  return res.data.id as number;
}

describe("the clinic books local patients", () => {
  it("can book inside the next 36 hours, which patients online cannot", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const before = app.sent.length;
    const id = await bookLocal(admin, adminId, checkup.id, MON_1400);
    const day = (await admin.get("/api/appointments?date=2026-10-12")).data.appointments;
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ id, source: "local", status: "booked", patientName: "Mimoza Berisha", patientPhone: "044111222" });
    // The patient gets a confirmation too.
    expect(app.sent[before]!.to).toBe("mimoza@example.test");
  });

  it("is refused a time that overlaps another appointment of the same dentist", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    await bookLocal(admin, adminId, checkup.id, WED_0900);
    const clash = await admin.post("/api/appointments", { dentistId: adminId, serviceId: checkup.id, startsAt: "2026-10-14T07:15:00.000Z", newPatient: { fullName: "Tjetër Pacient" } });
    expect(clash.status).toBe(409);
    // The refused request must not leave a patient behind.
    const patients = (await admin.get("/api/patients?q=Tjetër")).data.patients;
    expect(patients).toHaveLength(0);
  });

  it("a patient without email or phone can still be added and booked", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const res = await admin.post("/api/appointments", { dentistId: adminId, serviceId: checkup.id, startsAt: WED_0900, newPatient: { fullName: "Hasan Pa-Email" } });
    expect(res.status).toBe(201);
    expect(res.data.emailStatus).toBe("no_email");
  });

  it("offers staff the free slots of today without the 36-hour rule", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const slots = (await admin.get(`/api/slots?dentistId=${adminId}&serviceId=${checkup.id}&date=2026-10-12`)).data.slots;
    // It is 10:00, so 10:00 to 16:30 remain.
    expect(slots[0]).toBe("2026-10-12T08:00:00.000Z");
    expect(slots).toHaveLength(14);
  });
});

describe("the week at a glance", () => {
  const counts = async (c: Client, query: string) => (await c.get(`/api/appointments/counts?${query}`)).data.days as Array<{ date: string; count: number }>;

  it("counts each day's appointments on the clinic's calendar, without the cancelled ones", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    await bookLocal(admin, adminId, checkup.id, MON_1400);
    await bookLocal(admin, adminId, checkup.id, WED_0900);
    const gone = await bookLocal(admin, adminId, checkup.id, WED_1000);
    await admin.post(`/api/appointments/${gone}/cancel`, { reason: "Ndryshim" });
    // 23:30 on Thursday in Kosovo is 21:30 UTC: it belongs to Thursday, not to Friday, and not to "the 15th UTC" either way.
    await bookLocal(admin, adminId, checkup.id, "2026-10-15T21:30:00.000Z");
    expect(await counts(admin, "from=2026-10-12&days=7")).toEqual([
      { date: "2026-10-12", count: 1 },
      { date: "2026-10-13", count: 0 },
      { date: "2026-10-14", count: 1 },
      { date: "2026-10-15", count: 1 },
      { date: "2026-10-16", count: 0 },
      { date: "2026-10-17", count: 0 },
      { date: "2026-10-18", count: 0 },
    ]);
    // Seven days when nothing is said; never more than 31; a real date is required.
    expect(await counts(admin, "from=2026-10-12")).toHaveLength(7);
    expect((await admin.get("/api/appointments/counts?from=2026-10-12&days=32")).status).toBe(400);
    expect((await admin.get("/api/appointments/counts?from=tetor")).status).toBe(400);
    expect((await client(app.base).get("/api/appointments/counts?from=2026-10-12")).status).toBe(401);
    // It only reads.
    expect((await admin.post("/api/appointments/counts", {})).status).toBe(404);
  });

  it("shows a dentist their own numbers and the administrator the clinic's", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Pacient i Artës" });
    await bookLocal(besnik.client, besnik.id, checkup.id, WED_0900, { fullName: "Pacient i Besnikut" });
    // Its own address: an older test counts the reminders that go to the default one.
    await bookLocal(besnik.client, besnik.id, checkup.id, WED_1000, { fullName: "Pacient Tjetër", email: "tjeter-java@example.test" });
    const wed = async (c: Client, extra = "") => (await counts(c, `from=2026-10-14&days=1${extra}`))[0]!.count;
    expect(await wed(admin)).toBe(3);
    expect(await wed(admin, `&dentistId=${besnik.id}`)).toBe(2);
    expect(await wed(besnik.client)).toBe(2);
    // A dentist cannot ask for a colleague's numbers: the answer is still their own.
    expect(await wed(besnik.client, `&dentistId=${adminId}`)).toBe(2);
  });

  it("stops counting a colleague's patient for the treating dentist when the day list stops showing them", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    const patientId = (await admin.post("/api/patients", { fullName: "Pacient i Kolegut", dentistId: adminId })).data.patient.id as number;
    const visit = (await admin.post("/api/appointments", { dentistId: besnik.id, serviceId: checkup.id, startsAt: MON_1400, patientId })).data.id as number;
    const monday = async () => (await counts(besnik.client, "from=2026-10-12&days=1"))[0]!.count;
    expect(await monday()).toBe(1);
    app.setNow("2026-10-12T12:40:00Z");
    expect((await besnik.client.put(`/api/appointments/${visit}/report`, { workDone: "Kontroll i rregullt." })).status).toBe(200);
    // Same rule as the day list: seven days after it started, a finished visit with someone else's patient is gone.
    app.setNow("2026-10-19T12:00:01Z");
    expect((await besnik.client.get("/api/appointments?date=2026-10-12")).data.appointments).toHaveLength(0);
    expect(await monday()).toBe(0);
    expect((await counts(admin, "from=2026-10-12&days=1"))[0]!.count).toBe(1);
  });
});

describe("each dentist works with their own patients", () => {
  it("a dentist sees and books only their own calendar; the administrator sees the whole clinic", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    const mine = await bookLocal(besnik.client, besnik.id, checkup.id, WED_0900, { fullName: "Pacienti i Besnikut" });
    const hers = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Pacienti i Artës" });

    const besnikDay = (await besnik.client.get(`/api/appointments?date=2026-10-14&dentistId=${adminId}`)).data.appointments;
    expect(besnikDay.map((a: { id: number }) => a.id)).toEqual([mine]);
    expect((await besnik.client.get(`/api/appointments/${hers}`)).status).toBe(404);
    expect((await besnik.client.post(`/api/appointments/${hers}/cancel`, {})).status).toBe(404);
    expect((await besnik.client.put(`/api/appointments/${hers}/report`, { workDone: "nuk duhet të lejohet" })).status).toBe(404);
    expect((await besnik.client.post("/api/appointments", { dentistId: adminId, serviceId: checkup.id, startsAt: WED_1000, newPatient: { fullName: "Për kolegen" } })).status).toBe(403);

    expect((await admin.get("/api/appointments?date=2026-10-14")).data.appointments).toHaveLength(2);
    expect((await admin.get(`/api/appointments?date=2026-10-14&dentistId=${besnik.id}`)).data.appointments).toHaveLength(1);

    const besnikPatients = (await besnik.client.get("/api/patients")).data.patients;
    expect(besnikPatients.map((p: { fullName: string }) => p.fullName)).toEqual(["Pacienti i Besnikut"]);
    expect((await admin.get("/api/patients")).data.patients).toHaveLength(2);
  });

  it("nothing of the clinic is reachable without signing in, and what does not exist is not found", async () => {
    const a = await newClinic(app);
    const id = await bookLocal(a.admin, a.adminId, a.checkup.id, WED_0900);
    const patientId = (await a.admin.get("/api/patients")).data.patients[0].id;
    const nobody = client(app.base);
    expect((await nobody.get(`/api/appointments/${id}`)).status).toBe(401);
    expect((await nobody.get(`/api/patients/${patientId}`)).status).toBe(401);
    expect((await nobody.patch(`/api/patients/${patientId}`, { fullName: "Ndryshuar nga jashtë" })).status).toBe(401);
    expect((await nobody.get("/api/appointments?date=2026-10-14")).status).toBe(401);
    expect((await a.admin.get("/api/appointments/99999999")).status).toBe(404);
    expect((await a.admin.post("/api/appointments", { dentistId: a.adminId, serviceId: a.checkup.id, startsAt: WED_1000, patientId: 99999999 })).status).toBe(404);
    expect((await a.admin.post("/api/appointments", { dentistId: 99999999, serviceId: a.checkup.id, startsAt: WED_1000, newPatient: { fullName: "X Y Z" } })).status).toBe(400);
  });

  it("patients can be added, found by name or phone, and edited; only the administrator reassigns them", async () => {
    const { admin, adminId } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    const created = await besnik.client.post("/api/patients", { fullName: "Liridona Shala", phone: "049 555 666", birthDate: "1990-05-17", note: "Alergji në penicilinë" });
    expect(created.status).toBe(201);
    expect(created.data.patient).toMatchObject({ dentistId: besnik.id, source: "local", birthDate: "1990-05-17", phone: "049555666" });
    const id = created.data.patient.id;

    expect((await besnik.client.get("/api/patients?q=lirid")).data.patients).toHaveLength(1);
    expect((await besnik.client.get("/api/patients?q=049555")).data.patients).toHaveLength(1);
    expect((await besnik.client.get("/api/patients?q=%")).data.patients).toHaveLength(0);

    expect((await besnik.client.patch(`/api/patients/${id}`, { note: "Alergji në penicilinë dhe lateks" })).data.patient.note).toContain("lateks");
    expect((await besnik.client.patch(`/api/patients/${id}`, { dentistId: adminId })).status).toBe(403);
    expect((await admin.patch(`/api/patients/${id}`, { dentistId: adminId })).data.patient.dentistId).toBe(adminId);
    // No longer responsible and never treated them: the patient leaves the dentist's list.
    expect((await besnik.client.get(`/api/patients/${id}`)).status).toBe(404);
  });
});

describe("a patient who is not, or no longer, the dentist's own", () => {
  type Mail = { to: string };
  const mailsTo = async (c: Client, to: string) => ((await c.get("/api/emails")).data.emails as Mail[]).filter((e) => e.to === to).length;

  it("moved to a colleague: the former dentist loses the record at once and the visit after seven days; the new one gets the whole history", async () => {
    const { admin, checkup } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    const drita = await newDentist(app, admin, "Dr. Drita Hoxha");
    const visit = await bookLocal(besnik.client, besnik.id, checkup.id, MON_1400, { fullName: "Teuta Rama", email: "teuta@example.test", phone: "044 777 888" });
    app.setNow("2026-10-12T12:40:00Z");
    await besnik.client.put(`/api/appointments/${visit}/report`, { workDone: "Mbushje në dhëmbin 14.", nextVisitDays: 10 });
    const patientId = (await besnik.client.get(`/api/appointments/${visit}`)).data.appointment.patientId as number;
    expect((await besnik.client.get(`/api/patients/${patientId}`)).status).toBe(200);
    expect((await besnik.client.get("/api/due-visits")).data.due).toHaveLength(1);

    expect((await admin.patch(`/api/patients/${patientId}`, { dentistId: drita.id })).data.patient.dentistId).toBe(drita.id);

    // The record is gone for the former dentist on every patient route, whatever they treated before.
    expect((await besnik.client.get(`/api/patients/${patientId}`)).status).toBe(404);
    expect((await besnik.client.get("/api/patients")).data.patients).toHaveLength(0);
    expect((await besnik.client.get("/api/patients?q=Teuta")).data.patients).toHaveLength(0);
    expect((await besnik.client.patch(`/api/patients/${patientId}`, { note: "nuk duhet" })).status).toBe(404);
    expect((await besnik.client.post("/api/appointments", { dentistId: besnik.id, serviceId: checkup.id, startsAt: WED_0900, patientId })).status).toBe(404);
    expect((await besnik.client.get("/api/due-visits")).data.due).toHaveLength(0);
    // The visit they performed stays open for seven days, so the report can still be corrected.
    expect((await besnik.client.get(`/api/appointments/${visit}`)).status).toBe(200);
    expect(await mailsTo(besnik.client, "teuta@example.test")).toBe(1);

    // The dentist responsible now reads the whole history, including the colleague's report...
    const record = (await drita.client.get(`/api/patients/${patientId}`)).data;
    expect(record.patient).toMatchObject({ fullName: "Teuta Rama", phone: "044777888" });
    expect(record.visits).toHaveLength(1);
    expect(record.visits[0]).toMatchObject({ id: visit, workDone: "Mbushje në dhëmbin 14.", dentistName: "Dr. Besnik Gashi" });
    expect((await drita.client.get("/api/due-visits")).data.due.map((d: { patientId: number }) => d.patientId)).toEqual([patientId]);
    // ...but does not act on an appointment a colleague treated.
    expect((await drita.client.get(`/api/appointments/${visit}`)).status).toBe(404);
    expect((await drita.client.put(`/api/appointments/${visit}/report`, { workDone: "nuk duhet" })).status).toBe(404);

    // Exactly seven days after the visit started: still open. One second later: closed, on every route.
    app.setNow("2026-10-19T12:00:00Z");
    expect((await besnik.client.get(`/api/appointments/${visit}`)).status).toBe(200);
    app.setNow("2026-10-19T12:00:01Z");
    expect((await besnik.client.get(`/api/appointments/${visit}`)).status).toBe(404);
    expect((await besnik.client.get("/api/appointments?date=2026-10-12")).data.appointments).toHaveLength(0);
    expect((await besnik.client.get("/api/appointments?date=2026-10-12&q=Teuta")).data.appointments).toHaveLength(0);
    expect((await besnik.client.put(`/api/appointments/${visit}/report`, { workDone: "nuk duhet" })).status).toBe(404);
    expect((await besnik.client.post(`/api/appointments/${visit}/status`, { status: "no_show" })).status).toBe(404);
    expect((await besnik.client.post(`/api/appointments/${visit}/cancel`, { reason: "x", confirmLate: true })).status).toBe(404);
    expect(await mailsTo(besnik.client, "teuta@example.test")).toBe(0);
    expect((await besnik.client.get(`/api/patients/${patientId}`)).status).toBe(404);
    // The refusals changed nothing.
    const kept = (await admin.get(`/api/appointments/${visit}`)).data;
    expect(kept.appointment.status).toBe("completed");
    expect(kept.report).toMatchObject({ workDone: "Mbushje në dhëmbin 14.", version: 1 });

    // The administrator keeps everything.
    expect((await admin.get(`/api/patients/${patientId}`)).data.visits).toHaveLength(1);
    expect((await admin.get("/api/appointments?date=2026-10-12")).data.appointments).toHaveLength(1);
    expect(await mailsTo(admin, "teuta@example.test")).toBe(1);
    // For the former dentist too, "not yours" and "does not exist" are one answer.
    const gone = await besnik.client.get(`/api/appointments/${visit}`);
    const never = await besnik.client.get("/api/appointments/99999999");
    expect([gone.status, gone.data]).toEqual([never.status, never.data]);
  });

  it("booked with a colleague's patient: the dentist works that appointment, without the patient's record", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    const patientId = (await admin.post("/api/patients", { fullName: "Ilir Deda", phone: "045 222 333", email: "ilir@example.test", dentistId: adminId, note: "Diabetik" })).data.patient.id as number;
    const booked = await admin.post("/api/appointments", { dentistId: besnik.id, serviceId: checkup.id, startsAt: WED_0900, patientId });
    expect(booked.status).toBe(201);
    const visit = booked.data.id as number;

    // In the calendar and openable, with what is needed to treat and to phone.
    expect((await besnik.client.get("/api/appointments?date=2026-10-14")).data.appointments.map((a: { id: number }) => a.id)).toEqual([visit]);
    expect((await besnik.client.get(`/api/appointments/${visit}`)).data.appointment).toMatchObject({ patientName: "Ilir Deda", status: "booked" });
    expect(await mailsTo(besnik.client, "ilir@example.test")).toBe(1);
    // The record itself (note, history) stays with the responsible dentist.
    expect((await besnik.client.get(`/api/patients/${patientId}`)).status).toBe(404);
    expect((await besnik.client.get("/api/patients")).data.patients).toHaveLength(0);

    // Eight days on and still not marked: a booked appointment stays open until its work is done.
    app.setNow("2026-10-22T08:00:00Z");
    expect((await besnik.client.get(`/api/appointments/${visit}`)).status).toBe(200);
    expect((await besnik.client.put(`/api/appointments/${visit}/report`, { workDone: "Kontroll, pa gjetje." })).status).toBe(200);
    // Written, so completed; the seven days have passed; the patient is a colleague's: closed.
    expect((await besnik.client.get(`/api/appointments/${visit}`)).status).toBe(404);
    expect(await mailsTo(besnik.client, "ilir@example.test")).toBe(0);
    // The responsible dentist (here the administrator) reads the colleague's report in the history.
    expect((await admin.get(`/api/patients/${patientId}`)).data.visits[0]).toMatchObject({ workDone: "Kontroll, pa gjetje.", dentistName: "Dr. Besnik Gashi" });
  });

  it("a colleague's patient whose appointment was cancelled before it started: nothing is left to work on", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    const patientId = (await admin.post("/api/patients", { fullName: "Lule Gashi", phone: "045 444 555", email: "lule@example.test", dentistId: adminId })).data.patient.id as number;
    const visit = (await admin.post("/api/appointments", { dentistId: besnik.id, serviceId: checkup.id, startsAt: WED_0900, patientId })).data.id as number;
    expect((await besnik.client.get(`/api/appointments/${visit}`)).status).toBe(200);
    expect((await admin.post(`/api/appointments/${visit}/cancel`, { reason: "Pacienti u sëmur" })).status).toBe(200);

    // Still in the future, no longer booked, not their patient: closed on every route.
    expect((await besnik.client.get(`/api/appointments/${visit}`)).status).toBe(404);
    expect((await besnik.client.get("/api/appointments?date=2026-10-14")).data.appointments).toHaveLength(0);
    expect((await besnik.client.post(`/api/appointments/${visit}/status`, { status: "booked" })).status).toBe(404);
    expect((await besnik.client.put(`/api/appointments/${visit}/report`, { workDone: "nuk duhet" })).status).toBe(404);
    expect(await mailsTo(besnik.client, "lule@example.test")).toBe(0);
    expect((await admin.get(`/api/appointments/${visit}`)).data.appointment.status).toBe("cancelled");

    // With their own patient the same cancelled appointment stays readable: the record is theirs.
    const own = await bookLocal(besnik.client, besnik.id, checkup.id, WED_1000, { fullName: "Pacient i Vet", email: "ivet@example.test" });
    await besnik.client.post(`/api/appointments/${own}/cancel`, { reason: "Ndryshim orari" });
    expect((await besnik.client.get(`/api/appointments/${own}`)).data.appointment.status).toBe("cancelled");
    // And a booked one with a colleague's patient is open however far ahead it is.
    const ahead = (await admin.post("/api/appointments", { dentistId: besnik.id, serviceId: checkup.id, startsAt: "2026-11-11T08:00:00.000Z", patientId })).data.id as number;
    expect((await besnik.client.get(`/api/appointments/${ahead}`)).status).toBe(200);
  });

  it("an email tied to no appointment is the administrator's alone", async () => {
    const { admin, clinic } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    await app.ctx.db.query("INSERT INTO email_log (clinic_id, appointment_id, to_email, kind, subject, body, status) VALUES ($1, NULL, 'pa-termin@example.test', 'reminder', 'Kujtesë', 'tekst', 'stored')", [clinic.id]);
    expect(await mailsTo(admin, "pa-termin@example.test")).toBe(1);
    expect(await mailsTo(besnik.client, "pa-termin@example.test")).toBe(0);
  });
});

describe("the clinic cancels an appointment", () => {
  it("with enough warning: the patient is emailed and the slot is free again", async () => {
    const { admin, adminId, clinic, checkup } = await newClinic(app);
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900);
    const before = app.sent.length;
    const res = await admin.post(`/api/appointments/${id}/cancel`, { reason: "Stomatologu mungon" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ late: false, emailStatus: "accepted" });
    const mail = app.sent[before]!;
    expect(mail.to).toBe("mimoza@example.test");
    expect(mail.subject).toContain("u anulua");
    expect(mail.text).toContain("Stomatologu mungon");
    const wed = (await client(app.base).get(`/api/public/clinic/slots?serviceId=${checkup.id}&from=2026-10-14&days=1`)).data.days[0];
    expect(wed.slots).toContain(WED_0900);
    expect((await admin.post(`/api/appointments/${id}/cancel`, {})).status).toBe(409);
  });

  it("inside the promised 24 hours: only knowingly, with a reason, and recorded as late", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const id = await bookLocal(admin, adminId, checkup.id, TUE_0900);
    const refused = await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt i pajisjes" });
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe("late_cancellation");
    expect((await admin.post(`/api/appointments/${id}/cancel`, { confirmLate: true })).status).toBe(409); // still no reason
    const done = await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt i pajisjes", confirmLate: true });
    expect(done.status).toBe(200);
    expect(done.data.late).toBe(true);
    const stats = (await admin.get("/api/stats?from=2026-10-13&to=2026-10-13")).data.stats;
    expect(stats).toMatchObject({ total: 1, cancelledByClinic: 1, lateCancellations: 1 });
  });

  it("tells staff when the patient could not be emailed, with the phone number to call", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const withEmail = await bookLocal(admin, adminId, checkup.id, WED_0900);
    const noEmail = await bookLocal(admin, adminId, checkup.id, WED_1000, { fullName: "Pa Email Fare", email: "", phone: "045 999 000" });

    app.failMail.value = true;
    const failed = await admin.post(`/api/appointments/${withEmail}/cancel`, {});
    app.failMail.value = false;
    expect(failed.data).toMatchObject({ emailStatus: "failed", patientPhone: "044111222" });
    const outbox = (await admin.get("/api/emails")).data.emails;
    expect(outbox[0]).toMatchObject({ kind: "cancelled_by_clinic", status: "failed", error: "mail server refused" });

    const none = await admin.post(`/api/appointments/${noEmail}/cancel`, {});
    expect(none.data).toMatchObject({ emailStatus: "no_email", patientPhone: "045999000" });
  });

  it("cannot cancel an appointment that has started; it is marked instead", async () => {
      const { admin, adminId, checkup } = await newClinic(app);
      const id = await bookLocal(admin, adminId, checkup.id, MON_1400);
      expect((await admin.post(`/api/appointments/${id}/status`, { status: "no_show" })).status).toBe(409); // not started yet
      app.setNow("2026-10-12T12:40:00Z");
      expect((await admin.post(`/api/appointments/${id}/cancel`, { reason: "vonë", confirmLate: true })).status).toBe(409);
      expect((await admin.post(`/api/appointments/${id}/status`, { status: "no_show" })).status).toBe(200);
      expect((await admin.get(`/api/appointments/${id}`)).data.appointment.status).toBe("no_show");
      // The patient came after all: that is said by writing the report, not by pressing a mark.
      expect((await admin.post(`/api/appointments/${id}/status`, { status: "completed" })).status).toBe(409);
      expect((await admin.post(`/api/appointments/${id}/status`, { status: "booked" })).status).toBe(200);
      expect((await admin.put(`/api/appointments/${id}/report`, { workDone: "Erdhi me vonesë. Kontroll." })).status).toBe(200);
      expect((await admin.get(`/api/appointments/${id}`)).data.appointment.status).toBe("completed");
  });

  it("a dentist's time off cannot be booked, by patients or by staff", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    expect((await admin.post(`/api/staff/${adminId}/time-off`, { startsAt: "2026-10-14T06:00:00Z", endsAt: "2026-10-14T10:00:00Z" })).status).toBe(201);
    const res = await admin.post("/api/appointments", { dentistId: adminId, serviceId: checkup.id, startsAt: WED_0900, newPatient: { fullName: "Gjatë Pushimit" } });
    expect(res.status).toBe(409);
    expect((await admin.get("/api/patients?q=Pushimit")).data.patients).toHaveLength(0);
  });

  it("time off cannot silently swallow booked patients", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    await bookLocal(admin, adminId, checkup.id, WED_0900);
    const res = await admin.post(`/api/staff/${adminId}/time-off`, { startsAt: "2026-10-14T00:00:00Z", endsAt: "2026-10-15T00:00:00Z" });
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("1 termine");
  });
});

describe("visit reports", () => {
  it("follow the owner's flow: date, then the day's patients, then a name, then the report", async () => {
      const { admin, checkup } = await newClinic(app);
      const besnik = await newDentist(app, admin);
      const filling = await bookLocal(besnik.client, besnik.id, checkup.id, "2026-10-16T07:00:00.000Z", { fullName: "Agron Morina" });
      await bookLocal(besnik.client, besnik.id, checkup.id, "2026-10-16T08:00:00.000Z", { fullName: "Vjosa Kelmendi", email: "vjosa@example.test" });

      // A report describes work done: not before the day of the visit.
      expect((await besnik.client.put(`/api/appointments/${filling}/report`, { workDone: "Mbushje" })).status).toBe(409);

      app.setNow("2026-10-16T09:30:00Z");
      const day = (await besnik.client.get("/api/appointments?date=2026-10-16")).data.appointments;
      expect(day.map((a: { patientName: string }) => a.patientName)).toEqual(["Agron Morina", "Vjosa Kelmendi"]);
      const found = (await besnik.client.get("/api/appointments?date=2026-10-16&q=agron")).data.appointments;
      expect(found.map((a: { id: number }) => a.id)).toEqual([filling]);

      const saved = await besnik.client.put(`/api/appointments/${filling}/report`, { workDone: "Mbushje me ilaç në dhëmbin 36.", nextVisitDays: 14 });
      expect(saved.data).toEqual({ ok: true, version: 1 });
      const opened = (await besnik.client.get(`/api/appointments/${filling}`)).data;
      expect(opened.report).toMatchObject({ workDone: "Mbushje me ilaç në dhëmbin 36.", nextVisitDays: 14, version: 1, authorName: "Dr. Besnik Gashi" });
      // Writing the report means the visit happened.
      expect(opened.appointment.status).toBe("completed");
      expect(opened.appointment.hasReport).toBe(true);

      // A correction keeps the earlier text.
      app.setNow("2026-10-16T10:00:00Z");
      await besnik.client.put(`/api/appointments/${filling}/report`, { workDone: "Mbushje me ilaç në dhëmbin 37 (jo 36).", nextVisitDays: 14 });
      const again = (await besnik.client.get(`/api/appointments/${filling}`)).data;
      expect(again.report.version).toBe(2);
      expect(again.versions.map((v: { version: number; workDone: string }) => [v.version, v.workDone])).toEqual([
        [2, "Mbushje me ilaç në dhëmbin 37 (jo 36)."],
        [1, "Mbushje me ilaç në dhëmbin 36."],
      ]);

      // The patient's page shows the visit with its report.
      const patientId = again.appointment.patientId;
      const history = (await besnik.client.get(`/api/patients/${patientId}`)).data.visits;
      expect(history[0]).toMatchObject({ workDone: "Mbushje me ilaç në dhëmbin 37 (jo 36).", nextVisitDays: 14 });

      // "Next appointment in 14 days": the patient comes up as due, until something is booked.
      app.setNow("2026-10-28T08:00:00Z");
      // Sixteen days on, the two-week session has run out, as it should.
      expect((await besnik.client.get("/api/due-visits")).status).toBe(401);
      await besnik.client.post("/api/auth/login", { email: besnik.email, password: "fjalekalimi2" });
      const due =(await besnik.client.get("/api/due-visits")).data.due;
      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({ patientName: "Agron Morina" });
      // Fourteen calendar days after a 09:00 visit is 09:00 again on the clinic's clock. Summer time ended
      // on 25 October in between, so that is 08:00 UTC, not 07:00: the same hour for the patient, and the
      // same answer whatever timezone the database server itself is set to.
      expect(new Date(due[0].dueAt).toISOString()).toBe("2026-10-30T08:00:00.000Z");
      await besnik.client.post("/api/appointments", { dentistId: besnik.id, serviceId: checkup.id, startsAt: "2026-10-30T09:00:00.000Z", patientId });
      expect((await besnik.client.get("/api/due-visits")).data.due).toHaveLength(0);
  });

  it("are not written for a cancelled appointment", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900);
    await admin.post(`/api/appointments/${id}/cancel`, {});
    expect((await admin.put(`/api/appointments/${id}/report`, { workDone: "Diçka" })).status).toBe(409);
  });

  it("leave a trace: who wrote and who edited", async () => {
      const { admin, adminId, clinic, checkup } = await newClinic(app);
      const id = await bookLocal(admin, adminId, checkup.id, MON_1400);
      await admin.put(`/api/appointments/${id}/report`, { workDone: "Kontroll i rregullt." });
      await admin.put(`/api/appointments/${id}/report`, { workDone: "Kontroll i rregullt, pa gjetje." });
      const log = await app.ctx.db.query<{ action: string; user_id: number }>(
        "SELECT action, user_id FROM audit_log WHERE clinic_id = $1 AND entity = 'appointment' AND entity_id = $2 ORDER BY id",
        [clinic.id, id],
      );
      expect(log.map((l) => l.action)).toEqual(["appointment_booked_by_clinic", "report_created", "report_edited"]);
      expect(log.every((l) => l.user_id === adminId)).toBe(true);
  });
});

describe("reminders", () => {
  it("are sent once, the day before, and not for cancelled appointments", async () => {
      const { admin, adminId, clinic, checkup } = await newClinic(app);
      await client(app.base).post("/api/public/book", { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput({ email: "kujtese@example.test" }) });
      const cancelled = await bookLocal(admin, adminId, checkup.id, WED_1000);
      await admin.post(`/api/appointments/${cancelled}/cancel`, {});

      const reminders = () => app.sent.filter((m) => m.to === "kujtese@example.test" && m.subject.includes("Kujtesë")).length;
      await sendDueReminders(app.ctx); // 47 hours away: too early
      expect(reminders()).toBe(0);
      app.setNow("2026-10-13T08:00:00Z"); // 23 hours away
      await sendDueReminders(app.ctx);
      expect(reminders()).toBe(1);
      // The cancelled appointment of the same morning gets none.
      expect(app.sent.filter((m) => m.to === "mimoza@example.test" && m.subject.includes("Kujtesë") && m.text.includes("ora 10:00")).length).toBe(0);
      expect(await sendDueReminders(app.ctx)).toBe(0);
      expect(reminders()).toBe(1);
  });
});

describe("emails that did not get through", () => {
  interface Row {
    id: number;
    to: string;
    kind: string;
    status: string;
    attempts: number;
    canResend: boolean;
  }
  const outbox = async (c: Client, to: string) => ((await c.get("/api/emails")).data.emails as Row[]).filter((e) => e.to === to);
  const received = (to: string, subject: string) => app.sent.filter((m) => m.to === to && m.subject.includes(subject)).length;
  const later = (minutes: number) => app.setNow(new Date(app.ctx.now().getTime() + minutes * 60000).toISOString());
  // The tests of this file share one database, so a retry run may also pick up messages of earlier tests.
  // Each test therefore looks at its own message: how often it was attempted and how often it arrived.
  const retry = () => retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now());
  const attemptsOf = async (to: string, kind: string) => (await app.ctx.db.query<{ attempts: number }>("SELECT attempts FROM email_log WHERE to_email = $1 AND kind = $2", [to, kind])).map((r) => r.attempts);

  it("a reminder the mail server refused is tried again by itself, and arrives once", async () => {
    const { admin, clinic, checkup } = await newClinic(app);
    const to = "kujtese-deshtim@example.test";
    await client(app.base).post("/api/public/book", { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput({ email: to }) });
    app.setNow("2026-10-13T08:00:00Z"); // 23 hours before

    app.failMail.value = true;
    expect(await sendDueReminders(app.ctx)).toBe(1);
    app.failMail.value = false;
    expect(received(to, "Kujtesë")).toBe(0);
    expect((await outbox(admin, to)).filter((e) => e.kind === "reminder")).toMatchObject([{ status: "failed", attempts: 1, canResend: true }]);

    // The appointment is marked, so the reminder is not queued a second time...
    expect(await sendDueReminders(app.ctx)).toBe(0);
    // ...and a retry waits five minutes after the last attempt.
    await retry();
    expect(await attemptsOf(to, "reminder")).toEqual([1]);
    later(6);
    await retry();
    expect(received(to, "Kujtesë")).toBe(1);
    expect((await outbox(admin, to)).filter((e) => e.kind === "reminder")).toMatchObject([{ status: "accepted", attempts: 2, canResend: false }]);

    // Nothing is left to do: no second copy, however often the loop runs.
    later(6);
    await retry();
    expect(await sendDueReminders(app.ctx)).toBe(0);
    expect(await attemptsOf(to, "reminder")).toEqual([2]);
    expect(received(to, "Kujtesë")).toBe(1);
  });

  it("a reminder written down just before the server died is still sent, once", async () => {
    const { clinic, checkup } = await newClinic(app);
    const to = "kujtese-rrezim@example.test";
    const booked = await client(app.base).post("/api/public/book", { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput({ email: to }) });
    expect(booked.status).toBe(201);
    app.setNow("2026-10-13T08:00:00Z");
    // Exactly what sendDueReminders commits before it sends: the mark and the queued message, together.
    const appointment = (await app.ctx.db.query<{ id: number }>("SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE p.email = $1", [to]))[0]!;
    const email = (await composeReminder(app.ctx, appointment.id))!;
    await app.ctx.db.tx(async (q) => {
      await q.query("UPDATE appointments SET reminder_sent_at = $2 WHERE id = $1", [appointment.id, app.ctx.now()]);
      await queueEmail(q, email);
    });
    // ...and then the process is gone. On the next start:
    expect(received(to, "Kujtesë")).toBe(0);
    expect(await attemptsOf(to, "reminder")).toEqual([0]);
    expect(await sendDueReminders(app.ctx)).toBe(0);
    await retry();
    expect(received(to, "Kujtesë")).toBe(1);
    later(6);
    await retry();
    expect(await attemptsOf(to, "reminder")).toEqual([1]);
    expect(received(to, "Kujtesë")).toBe(1);
  });

  it("stops trying by itself after three attempts; staff can still send it by hand", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = "tri-here@example.test";
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Tri Herë", email: to });
    app.failMail.value = true;
    expect((await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" })).data.emailStatus).toBe("failed");
    for (let i = 0; i < 4; i++) {
      later(6);
      await retry();
    }
    const row = (await outbox(admin, to)).find((e) => e.kind === "cancelled_by_clinic")!;
    expect(row).toMatchObject({ status: "failed", attempts: 3, canResend: true });
    expect(received(to, "u anulua")).toBe(0);

    app.failMail.value = false;
    later(6);
    await retry(); // given up: the message is not attempted a fourth time
    expect(await attemptsOf(to, "cancelled_by_clinic")).toEqual([3]);
    expect(received(to, "u anulua")).toBe(0);
    const resent = await admin.post(`/api/emails/${row.id}/resend`);
    expect([resent.status, resent.data]).toEqual([200, { status: "accepted" }]);
    expect(received(to, "u anulua")).toBe(1);
  });

  it("sending again by hand never produces a second copy", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    const to = "dy-klikime@example.test";
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Dy Klikime", email: to });
    app.failMail.value = true;
    await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" });
    app.failMail.value = false;
    const row = (await outbox(admin, to)).find((e) => e.kind === "cancelled_by_clinic")!;
    later(3);

    // Two clicks at the same moment, with a mail server that takes its time: the second request arrives
    // while the first is still sending. One sends, the other is told to wait.
    app.mailDelay.ms = 400;
    const both = await Promise.all([admin.post(`/api/emails/${row.id}/resend`), admin.post(`/api/emails/${row.id}/resend`)]);
    app.mailDelay.ms = 0;
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)!.data.error).toContain("po dërgohet");
    expect(received(to, "u anulua")).toBe(1);
    // Later clicks: the mail server has it, so it is not sent again.
    later(10);
    const again = await admin.post(`/api/emails/${row.id}/resend`);
    expect(again.status).toBe(409);
    expect(again.data.error).toContain("pranuar");
    expect(received(to, "u anulua")).toBe(1);

    // A colleague whose patient this is not cannot touch it, and gets the same answer as for an id that does not exist.
    const foreign = await besnik.client.post(`/api/emails/${row.id}/resend`);
    const missing = await besnik.client.post("/api/emails/99999999/resend");
    expect([foreign.status, foreign.data]).toEqual([404, missing.data]);
  });

  it("a mail server that takes minutes over a message does not get the message twice", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = "server-i-ngadalte@example.test";
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Server i Ngadaltë", email: to });
    app.failMail.value = true;
    await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" });
    app.failMail.value = false;
    const row = (await outbox(admin, to)).find((e) => e.kind === "cancelled_by_clinic")!;

    // The first resend is on its way and the mail server has not answered yet...
    app.mailDelay.ms = 700;
    const first = admin.post(`/api/emails/${row.id}/resend`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // ...three minutes pass, as far as the clock goes: longer than a claim used to last...
    later(3);
    // ...and neither a second click nor the retry loop may start another send of it.
    const second = await admin.post(`/api/emails/${row.id}/resend`);
    expect(second.status).toBe(409);
    expect(second.data.error).toContain("po dërgohet");
    await retry();
    expect(await attemptsOf(to, "cancelled_by_clinic")).toEqual([2]);
    expect((await first).data).toEqual({ status: "accepted" });
    app.mailDelay.ms = 0;
    expect(received(to, "u anulua")).toBe(1);
  });

  it("an attempt abandoned by a crash is picked up again after five minutes, not before", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = "perpjekje-e-braktisur@example.test";
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "E Braktisur", email: to });
    app.failMail.value = true;
    await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" });
    app.failMail.value = false;
    const row = (await outbox(admin, to)).find((e) => e.kind === "cancelled_by_clinic")!;
    // What a process leaves behind when it dies in the middle of a send: the claim, never given back.
    await app.ctx.db.query("UPDATE email_log SET sending_since = $2, last_attempt_at = $2, attempts = attempts + 1 WHERE id = $1", [row.id, app.ctx.now()]);
    later(4);
    expect((await admin.post(`/api/emails/${row.id}/resend`)).status).toBe(409);
    expect(received(to, "u anulua")).toBe(0);
    later(2);
    expect((await admin.post(`/api/emails/${row.id}/resend`)).data).toEqual({ status: "accepted" });
    expect(received(to, "u anulua")).toBe(1);
  });

  it("a mail server that does not answer in time: nothing new is sent while that send may still go through, and afterwards the patient can get it twice", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = "pa-pergjigje@example.test";
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Pa Përgjigje", email: to });
    // The mail server needs 600 ms; the attempt waits 100 ms. The send itself cannot be called back.
    app.mailDelay.ms = 600;
    app.ctx.mailer!.timeoutMs = 100;
    let row: Row;
    try {
      const cancelled = await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" });
      // Staff are told it failed, with the phone number: the honest answer when the outcome is unknown.
      expect(cancelled.data).toMatchObject({ emailStatus: "failed", patientPhone: "044111222" });
      const log = await app.ctx.db.query<{ status: string; error: string; sending_since: Date | null }>("SELECT status, error, sending_since FROM email_log WHERE to_email = $1 AND kind = 'cancelled_by_clinic'", [to]);
      expect(log[0]).toMatchObject({ status: "failed" });
      expect(log[0]!.error).toContain("whether it took the message is unknown");
      // The claim is kept: the first send is still out.
      expect(log[0]!.sending_since).not.toBeNull();
      expect(received(to, "u anulua")).toBe(0);

      // A click and the retry loop, while that send is still on its way: neither starts a second one.
      row = (await outbox(admin, to)).find((e) => e.kind === "cancelled_by_clinic")!;
      const early = await admin.post(`/api/emails/${row.id}/resend`);
      expect(early.status).toBe(409);
      expect(early.data.error).toContain("pa përgjigje");
      await retry();
      expect(await attemptsOf(to, "cancelled_by_clinic")).toEqual([1]);

      // The mail server finishes late: the patient has the notice, and the system does not know it.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(received(to, "u anulua")).toBe(1);
      expect((await outbox(admin, to)).find((e) => e.id === row.id)).toMatchObject({ status: "failed", canResend: true });
      // Still inside the five minutes: still nothing new.
      later(4);
      expect((await admin.post(`/api/emails/${row.id}/resend`)).status).toBe(409);
      expect(received(to, "u anulua")).toBe(1);
    } finally {
      app.mailDelay.ms = 0;
      app.ctx.mailer!.timeoutMs = undefined;
    }
    // After the claim has lapsed the message is sent again, because as far as the system knows it never
    // arrived. This is the duplicate that cannot be avoided: two copies, not one. It is asserted here so
    // that nobody reads "sent once" into this code.
    later(2);
    expect((await admin.post(`/api/emails/${row.id}/resend`)).data).toEqual({ status: "accepted" });
    expect(received(to, "u anulua")).toBe(2);
  });

  it("a mail server that refuses a message gives it back at once: staff can resend without waiting", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = "refuzim@example.test";
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Refuzim", email: to });
    app.failMail.value = true;
    await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" });
    app.failMail.value = false;
    expect(await app.ctx.db.query("SELECT status, sending_since FROM email_log WHERE to_email = $1 AND kind = 'cancelled_by_clinic'", [to])).toEqual([{ status: "failed", sending_since: null }]);
    const row = (await outbox(admin, to)).find((e) => e.kind === "cancelled_by_clinic")!;
    expect((await admin.post(`/api/emails/${row.id}/resend`)).data).toEqual({ status: "accepted" });
    expect(received(to, "u anulua")).toBe(1);
  });

  it("a confirmation is not sent any more once its appointment is cancelled", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = "konfirmim-vone@example.test";
    app.failMail.value = true;
    const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Konfirmim Vonë", email: to });
    app.failMail.value = false;
    await admin.post(`/api/appointments/${id}/cancel`, { reason: "Ndryshim" });
    const confirmation = (await outbox(admin, to)).find((e) => e.kind === "booking_confirmation")!;
    expect(confirmation).toMatchObject({ status: "failed", canResend: false });
    later(6);
    await retry();
    expect((await admin.post(`/api/emails/${confirmation.id}/resend`)).status).toBe(409);
    expect(received(to, "u caktua")).toBe(0);
    expect(received(to, "u anulua")).toBe(1);
  });

  it("without a mail server nothing is sent and nothing claims to be; with one, what is still ahead goes out", async () => {
    const { admin, adminId, checkup } = await newClinic(app);
    const to = "pa-server@example.test";
    const mailer = app.ctx.mailer;
    app.ctx.mailer = null;
    try {
      const id = await bookLocal(admin, adminId, checkup.id, WED_0900, { fullName: "Pa Server", email: to });
      const cancelled = await admin.post(`/api/appointments/${id}/cancel`, { reason: "Defekt" });
      expect(cancelled.data).toMatchObject({ emailStatus: "stored", patientPhone: "044111222" });
      const box = (await admin.get("/api/emails")).data;
      expect(box.canSend).toBe(false);
      const row = (box.emails as Row[]).find((e) => e.to === to && e.kind === "cancelled_by_clinic")!;
      expect(row).toMatchObject({ status: "stored", attempts: 0 });
      expect((await admin.post(`/api/emails/${row.id}/resend`)).status).toBe(409);
      expect(await retry()).toBe(0);
    } finally {
      app.ctx.mailer = mailer;
    }
    expect(received(to, "u anulua")).toBe(0);
    // The mail server is configured later: the cancellation of an appointment still ahead is sent, the
    // confirmation of that cancelled appointment is not.
    await retry();
    expect(received(to, "u anulua")).toBe(1);
    expect(received(to, "u caktua")).toBe(0);
  });

  it("an older database, where 'sent' claimed too much, is brought up to date on start", async () => {
    const { clinic } = await newClinic(app);
    const db = app.ctx.db;
    // Put the table back the way an older version left it: the old rule, and every accepted row as 'sent'.
    await db.query("ALTER TABLE email_log DROP CONSTRAINT email_log_status_check");
    await db.query("UPDATE email_log SET status = 'sent' WHERE status = 'accepted'");
    await db.query("ALTER TABLE email_log ADD CONSTRAINT email_log_status_check CHECK (status IN ('sent', 'stored', 'failed'))");
    await db.query("INSERT INTO email_log (clinic_id, to_email, kind, subject, body, status) VALUES ($1, 'vjeter@example.test', 'reminder', 'Kujtesë', 'tekst', 'sent')", [clinic.id]);
    // Such a database predates versioned migrations: it has no record of any. That is how it is recognised.
    await db.query("DROP TABLE schema_migrations");
    expect((await db.migrate()).applied.map((m) => m.version)).toEqual(loadMigrations().map((m) => m.version));
    expect(await db.query("SELECT status, attempts FROM email_log WHERE to_email = 'vjeter@example.test'")).toEqual([{ status: "accepted", attempts: 1 }]);
    await expect(db.query("INSERT INTO email_log (clinic_id, to_email, kind, subject, body, status) VALUES ($1, 'x@example.test', 'reminder', 's', 'b', 'sent')", [clinic.id])).rejects.toThrow();
    // Running it again applies nothing.
    expect((await db.migrate()).applied).toEqual([]);
    expect(await db.query("SELECT count(*)::int AS n FROM email_log WHERE status = 'sent'")).toEqual([{ n: 0 }]);
  });
});
