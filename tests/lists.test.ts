import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, newClinic, newDentist, startApp, type TestApp } from "./helpers";

// Two lists for the dentist's day-to-day: the booked appointments of a month, and the reports of a week.
// Both follow the same rule as everything else: a dentist sees their own, the administrator the clinic's.

const NOW = "2026-10-12T08:00:00Z"; // Monday 12 October 2026, 10:00 in Kosovo

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
beforeEach(() => app.setNow(NOW));

type Clinic = Awaited<ReturnType<typeof newClinic>>;
const book = async (c: Clinic, startsAt: string, dentistId: number, name: string) => {
  const res = await c.admin.post("/api/appointments", { dentistId, serviceId: c.checkup.id, startsAt, newPatient: { fullName: name, phone: "044 111 222" } });
  expect(res.status, `${name} ${startsAt}`).toBe(201);
  return res.data.id as number;
};

describe("the booked appointments of a month", () => {
  it("lists what is booked in that month, in order, and nothing cancelled, finished or of another month", async () => {
    const c = await newClinic(app);
    const first = await book(c, "2026-10-14T07:00:00.000Z", c.adminId, "Pacient Një");
    const second = await book(c, "2026-10-30T08:00:00.000Z", c.adminId, "Pacient Dy");
    const cancelled = await book(c, "2026-10-15T07:00:00.000Z", c.adminId, "Pacient i Anuluar");
    const november = await book(c, "2026-11-02T08:00:00.000Z", c.adminId, "Pacient Nëntori");
    await c.admin.post(`/api/appointments/${cancelled}/cancel`, { reason: "Ndryshim" });
    // One today, already seen and reported: no longer "booked".
    const done = await book(c, "2026-10-12T08:30:00.000Z", c.adminId, "Pacient i Kryer");
    app.setNow("2026-10-12T12:00:00Z");
    await c.admin.put(`/api/appointments/${done}/report`, { workDone: "Kontroll." });

    const october = (await c.admin.get("/api/appointments/booked?month=2026-10")).data.appointments;
    expect(october.map((a: { id: number }) => a.id)).toEqual([first, second]);
    expect(october.every((a: { status: string }) => a.status === "booked")).toBe(true);
    expect((await c.admin.get("/api/appointments/booked?month=2026-11")).data.appointments.map((a: { id: number }) => a.id)).toEqual([november]);
    expect((await c.admin.get("/api/appointments/booked?month=2026-12")).data.appointments).toEqual([]);
  });

  it("follows the clinic's calendar at the ends of the month", async () => {
    const c = await newClinic(app);
    // Friday 30 October 16:30 in Kosovo, and Monday 2 November 09:00: either side of the month's end.
    const lastOfOctober = await book(c, "2026-10-30T15:30:00.000Z", c.adminId, "Fundi i Tetorit");
    const firstOfNovember = await book(c, "2026-11-02T08:00:00.000Z", c.adminId, "Fillimi i Nëntorit");
    expect((await c.admin.get("/api/appointments/booked?month=2026-10")).data.appointments.map((a: { id: number }) => a.id)).toEqual([lastOfOctober]);
    expect((await c.admin.get("/api/appointments/booked?month=2026-11")).data.appointments.map((a: { id: number }) => a.id)).toEqual([firstOfNovember]);
  });

  it("a dentist gets their own, whatever they ask for; the administrator can narrow to one dentist", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const hers = await book(c, "2026-10-14T07:00:00.000Z", c.adminId, "Pacient i Artës");
    const his = await book(c, "2026-10-14T07:00:00.000Z", besnik.id, "Pacient i Besnikut");
    const ids = async (who: ReturnType<typeof client>, extra = "") => (await who.get(`/api/appointments/booked?month=2026-10${extra}`)).data.appointments.map((a: { id: number }) => a.id);
    expect(await ids(c.admin)).toEqual([hers, his].sort((a, b) => a - b));
    expect(await ids(c.admin, `&dentistId=${besnik.id}`)).toEqual([his]);
    expect(await ids(besnik.client)).toEqual([his]);
    expect(await ids(besnik.client, `&dentistId=${c.adminId}`)).toEqual([his]);
  });

  it("refuses what is not a month, and anybody who is not signed in", async () => {
    const c = await newClinic(app);
    for (const bad of ["2026-13", "2026-1", "tetor", "2026-10-14", ""]) expect((await c.admin.get(`/api/appointments/booked?month=${bad}`)).status, bad).toBe(400);
    expect((await client(app.base).get("/api/appointments/booked?month=2026-10")).status).toBe(401);
  });
});

describe("the reports of a week", () => {
  async function reported(c: Clinic, startsAt: string, name: string, dentistId = c.adminId, who = c.admin) {
    app.setNow("2026-10-05T06:00:00Z");
    const id = await book(c, startsAt, dentistId, name);
    app.setNow("2026-10-16T16:00:00Z");
    expect((await who.put(`/api/appointments/${id}/report`, { workDone: `Raport për ${name}.`, nextVisitDays: 14 })).status).toBe(200);
    return id;
  }

  it("gives the week that holds the date asked for, Monday to Sunday, with every report and the count per day", async () => {
    const c = await newClinic(app);
    const monday = await reported(c, "2026-10-12T07:00:00.000Z", "E Hëna");
    const wednesdayA = await reported(c, "2026-10-14T07:00:00.000Z", "E Mërkura Një");
    const wednesdayB = await reported(c, "2026-10-14T08:00:00.000Z", "E Mërkura Dy");
    await reported(c, "2026-10-09T07:00:00.000Z", "Java e Kaluar");
    // Booked in the same week, with no report: not a report.
    app.setNow("2026-10-05T06:00:00Z");
    await book(c, "2026-10-15T07:00:00.000Z", c.adminId, "Pa Raport");
    app.setNow("2026-10-16T16:00:00Z");

    for (const asked of ["2026-10-12", "2026-10-14", "2026-10-18"]) {
      const week = (await c.admin.get(`/api/reports/week?date=${asked}`)).data;
      expect([week.from, week.to], asked).toEqual(["2026-10-12", "2026-10-18"]);
      expect(week.days.map((d: { date: string; count: number }) => d.count)).toEqual([1, 0, 2, 0, 0, 0, 0]);
      expect(week.reports.map((r: { appointmentId: number }) => r.appointmentId)).toEqual([monday, wednesdayA, wednesdayB]);
    }
    const one = (await c.admin.get("/api/reports/week?date=2026-10-14")).data.reports[1];
    expect(one).toMatchObject({ date: "2026-10-14", patientName: "E Mërkura Një", workDone: "Raport për E Mërkura Një.", nextVisitDays: 14, version: 1, images: 0, dentistName: "Dr. Arta Krasniqi" });

    const before = (await c.admin.get("/api/reports/week?date=2026-10-11")).data;
    expect([before.from, before.to, before.reports.length]).toEqual(["2026-10-05", "2026-10-11", 1]);
    expect((await c.admin.get("/api/reports/week?date=2026-10-19")).data.reports).toEqual([]);
  });

  it("a dentist sees the reports of their own visits; nobody sees any without signing in; a wrong date is refused", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    await reported(c, "2026-10-13T07:00:00.000Z", "Pacient i Artës");
    const his = await reported(c, "2026-10-13T07:00:00.000Z", "Pacient i Besnikut", besnik.id, besnik.client);
    expect((await besnik.client.get("/api/reports/week?date=2026-10-13")).data.reports.map((r: { appointmentId: number }) => r.appointmentId)).toEqual([his]);
    expect((await c.admin.get("/api/reports/week?date=2026-10-13")).data.reports).toHaveLength(2);
    expect((await client(app.base).get("/api/reports/week?date=2026-10-13")).status).toBe(401);
    expect((await c.admin.get("/api/reports/week?date=2026-02-31")).status).toBe(400);
    expect((await c.admin.get("/api/reports/week?date=tetor")).status).toBe(400);
  });
});
