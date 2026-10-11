import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXCLUSION_VIOLATION, pgErrorCode } from "../src/server/db";
import { client, newClinic, newDentist, patientInput, startApp, type TestApp } from "./helpers";

// The clock is pinned at Monday 12 October 2026, 10:00 in Kosovo (08:00 UTC, summer time, UTC+2).
// 36 hours later is Tuesday 22:00, so the first bookable working day is Wednesday 14 October.
const WED_0900 = "2026-10-14T07:00:00.000Z";
const WED_0930 = "2026-10-14T07:30:00.000Z";
const TUE_0900 = "2026-10-13T07:00:00.000Z";
const NOW = "2026-10-12T08:00:00Z";

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
beforeEach(() => {
  app.setNow(NOW);
  app.ctx.maxBookingsPerHour = 1000;
});

const pub = () => client(app.base);

describe("the public booking page", () => {
  it("shows the clinic, its services and dentists, and nothing about patients", async () => {
    const { clinic } = await newClinic(app);
    const page = (await pub().get(`/api/public/clinics/${clinic.slug}`)).data;
    expect(page.clinic.bookingNoticeHours).toBe(36);
    expect(page.clinic.cancelNoticeHours).toBe(24);
    expect(page.dentists).toHaveLength(1);
    expect(page.firstDate).toBe("2026-10-13");
    expect(JSON.stringify(page)).not.toMatch(/email|password/i);
  });

  it("offers no slot inside the next 36 hours and a full day after that", async () => {
    const { clinic, checkup } = await newClinic(app);
    const days = (await pub().get(`/api/public/clinics/${clinic.slug}/slots?serviceId=${checkup.id}&from=2026-10-12&days=3`)).data.days;
    expect(days.map((d: { date: string; slots: string[] }) => [d.date, d.slots.length])).toEqual([
      ["2026-10-12", 0],
      ["2026-10-13", 0],
      ["2026-10-14", 16], // 09:00 to 16:30, every 30 minutes
    ]);
    expect(days[2].slots[0]).toBe(WED_0900);
  });

  it("follows the clinic's timezone across the end of summer time", async () => {
    const { clinic, checkup } = await newClinic(app);
    // Monday 26 October 2026 is after the clocks go back: 09:00 in Kosovo is 08:00 UTC, not 07:00.
    const days = (await pub().get(`/api/public/clinics/${clinic.slug}/slots?serviceId=${checkup.id}&from=2026-10-26&days=1`)).data.days;
    expect(days[0].slots[0]).toBe("2026-10-26T08:00:00.000Z");
  });

  it("does not offer a dentist's time off, and offers nothing beyond the booking horizon", async () => {
    const { admin, adminId, clinic, checkup } = await newClinic(app);
    await admin.post(`/api/staff/${adminId}/time-off`, { startsAt: "2026-10-14T06:00:00Z", endsAt: "2026-10-14T10:00:00Z", reason: "Konferencë" });
    const wed = (await pub().get(`/api/public/clinics/${clinic.slug}/slots?serviceId=${checkup.id}&from=2026-10-14&days=1`)).data.days[0];
    expect(wed.slots[0]).toBe("2026-10-14T10:00:00.000Z");
    const far = (await pub().get(`/api/public/clinics/${clinic.slug}/slots?serviceId=${checkup.id}&from=2027-03-01&days=5`)).data.days;
    expect(far.every((d: { slots: string[] }) => d.slots.length === 0)).toBe(true);
  });
});

describe("booking online", () => {
  it("books a free slot, stores when the notice was accepted, and emails a confirmation with the private link", async () => {
    const { clinic, checkup } = await newClinic(app);
    const before = app.sent.length;
    const who = patientInput();
    const res = await pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...who });
    expect(res.status).toBe(201);
    expect(res.data.emailStatus).toBe("accepted");

    const mail = app.sent[before]!;
    expect(mail.to).toBe(who.email);
    expect(mail.text).toContain(`http://test.local/termin#${res.data.token}`);
    expect(mail.text).toContain("24 orë");
    expect(mail.text).toContain("ora 09:00");

    const rows = await app.ctx.db.query<{ notice_accepted_at: Date; token_hash: string; source: string }>(
      "SELECT notice_accepted_at, token_hash, source FROM appointments WHERE clinic_id = $1",
      [clinic.id],
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.notice_accepted_at).toISOString()).toBe("2026-10-12T08:00:00.000Z");
    expect(rows[0]!.source).toBe("online");
    // Only the hash of the link token is stored.
    expect(rows[0]!.token_hash).not.toBe(res.data.token);
    expect(rows[0]!.token_hash).toHaveLength(64);
  });

  it("refuses a slot inside the next 36 hours even when the request is sent directly", async () => {
    const { clinic, checkup } = await newClinic(app);
    const res = await pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: TUE_0900, ...patientInput() });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("36 orë");
  });

  it("refuses a booking when the cancellation notice was not accepted", async () => {
    const { clinic, checkup } = await newClinic(app);
    const res = await pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput({ acceptNotice: false }) });
    expect(res.status).toBe(400);
    expect(res.data.fields.acceptNotice).toBeTruthy();
  });

  it("refuses a time the schedule does not offer", async () => {
    const { clinic, checkup } = await newClinic(app);
    const book = (startsAt: string) => pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt, ...patientInput() });
    expect((await book("2026-10-14T07:07:00.000Z")).status).toBe(409); // not on the 30-minute grid
    expect((await book("2026-10-14T05:00:00.000Z")).status).toBe(409); // 07:00, before opening
    expect((await book("2026-10-17T07:00:00.000Z")).status).toBe(409); // Saturday
    expect((await book("2026-10-14T15:00:00.000Z")).status).toBe(409); // 17:00, would end after closing
  });

  it("lets exactly one of two patients who ask for the same slot at the same moment have it", async () => {
    const { clinic, checkup } = await newClinic(app);
    const book = () => pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput() });
    const results = await Promise.all([book(), book(), book()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    // The slot is gone from the page too.
    const wed = (await pub().get(`/api/public/clinics/${clinic.slug}/slots?serviceId=${checkup.id}&from=2026-10-14&days=1`)).data.days[0];
    expect(wed.slots).not.toContain(WED_0900);
    expect(wed.slots).toContain(WED_0930);
  });

  it("the database itself refuses an overlapping appointment, whatever the application does", async () => {
    const { clinic, checkup, adminId } = await newClinic(app);
    await pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput() });
    const patient = await app.ctx.db.query<{ id: number }>("SELECT id FROM patients WHERE clinic_id = $1", [clinic.id]);
    let code: string | undefined;
    try {
      // 09:15 to 09:45 overlaps 09:00 to 09:30.
      await app.ctx.db.query(
        "INSERT INTO appointments (clinic_id, dentist_id, patient_id, service_id, starts_at, ends_at, source) VALUES ($1, $2, $3, $4, $5, $6, 'local')",
        [clinic.id, adminId, patient[0]!.id, checkup.id, "2026-10-14T07:15:00Z", "2026-10-14T07:45:00Z"],
      );
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe(EXCLUSION_VIOLATION);
  });

  it("with 'any dentist', fills each free dentist once and then says the slot is taken", async () => {
    const { admin, clinic, checkup } = await newClinic(app);
    await newDentist(app, admin);
    const book = () => pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput() });
    expect((await book()).status).toBe(201);
    expect((await book()).status).toBe(201);
    expect((await book()).status).toBe(409);
    const dentists = await app.ctx.db.query<{ dentist_id: number }>("SELECT DISTINCT dentist_id FROM appointments WHERE clinic_id = $1", [clinic.id]);
    expect(dentists).toHaveLength(2);
  });

  it("limits how many open appointments one person can hold online", async () => {
    const { clinic, checkup } = await newClinic(app);
    const who = patientInput();
    const book = (startsAt: string) => pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt, ...who });
    expect((await book("2026-10-14T07:00:00.000Z")).status).toBe(201);
    expect((await book("2026-10-14T08:00:00.000Z")).status).toBe(201);
    expect((await book("2026-10-14T09:00:00.000Z")).status).toBe(201);
    expect((await book("2026-10-14T10:00:00.000Z")).status).toBe(409);
    // The same person is one patient record, not three.
    const patients = await app.ctx.db.query("SELECT id FROM patients WHERE clinic_id = $1", [clinic.id]);
    expect(patients).toHaveLength(1);
  });

  it("holds the per-person limit even when the requests arrive at the same moment", async () => {
    const { clinic, checkup } = await newClinic(app);
    const who = patientInput();
    const starts = ["07:00", "08:00", "09:00", "10:00", "11:00"].map((t) => `2026-10-14T${t}:00.000Z`);
    const results = await Promise.all(starts.map((startsAt) => pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt, ...who })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it("slows down a flood of bookings from one address", async () => {
      const { clinic, checkup } = await newClinic(app);
      await app.ctx.limiter!.reset("booking");
      app.ctx.maxBookingsPerHour = 2;
      const book = (startsAt: string) => client(app.base).post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt, ...patientInput() });
      expect((await book("2026-10-14T07:00:00.000Z")).status).toBe(201);
      expect((await book("2026-10-14T08:00:00.000Z")).status).toBe(201);
      expect((await book("2026-10-14T09:00:00.000Z")).status).toBe(429);
  });

  it("holds that limit when the bookings arrive at the same moment", async () => {
      const { clinic, checkup } = await newClinic(app);
      await app.ctx.limiter!.reset("booking");
      app.ctx.maxBookingsPerHour = 2;
      const book = (startsAt: string) => client(app.base).post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt, ...patientInput() });
      // Six different free times, asked for together from one address.
      const results = await Promise.all(["07:00", "07:30", "08:00", "08:30", "09:00", "09:30"].map((t) => book(`2026-10-14T${t}:00.000Z`)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 429)).toHaveLength(4);
      await app.ctx.limiter!.reset("booking");
  });
});

describe("the patient's private link", () => {
  it("shows the appointment and lets the patient cancel it; the slot is free again and the link is dead", async () => {
    const { clinic, checkup } = await newClinic(app);
    const who = patientInput();
    const booked = await pub().post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...who });
    const token = booked.data.token as string;

    const view = await pub().get("/api/public/appointment", { "x-appointment-token": token });
    expect(view.status).toBe(200);
    expect(view.data.appointment.status).toBe("booked");
    expect(view.data.appointment.when).toContain("14 tetor 2026");

    const before = app.sent.length;
    expect((await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": token })).status).toBe(200);
    expect(app.sent[before]!.to).toBe(who.email);
    expect(app.sent[before]!.subject).toContain("Anulimi");

    expect((await pub().get("/api/public/appointment", { "x-appointment-token": token })).status).toBe(404);
    const wed = (await pub().get(`/api/public/clinics/${clinic.slug}/slots?serviceId=${checkup.id}&from=2026-10-14&days=1`)).data.days[0];
    expect(wed.slots).toContain(WED_0900);
  });

  it("is opened by a token sent in a header: no address, however it is written, opens an appointment", async () => {
    const { clinic, checkup } = await newClinic(app);
    const booked = await client(app.base).post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput() });
    const token = booked.data.token as string;
    for (const address of ["/api/public/appointment", `/api/public/appointment?token=${token}`, `/api/public/appointment/${token}`, `/api/public/appointments/${token}`]) {
      expect((await client(app.base).get(address)).status).toBe(404);
    }
    expect((await client(app.base).post(`/api/public/appointments/${token}/cancel`)).status).toBe(404);
    expect((await client(app.base).post("/api/public/appointment/cancel")).status).toBe(404);
    expect((await client(app.base).get("/api/public/appointment", { "x-appointment-token": token })).data.appointment.status).toBe("booked");
  });

  it("stops working once the appointment has started, and a made-up token finds nothing", async () => {
      const { clinic, checkup } = await newClinic(app);
      const booked = await client(app.base).post(`/api/public/clinics/${clinic.slug}/book`, { serviceId: checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput() });
      expect((await client(app.base).get("/api/public/appointment", { "x-appointment-token": "x".repeat(43) })).status).toBe(404);
      app.setNow("2026-10-14T07:00:01Z");
      expect((await client(app.base).get("/api/public/appointment", { "x-appointment-token": booked.data.token })).status).toBe(404);
      expect((await client(app.base).post("/api/public/appointment/cancel", {}, { "x-appointment-token": booked.data.token })).status).toBe(404);
  });
});
