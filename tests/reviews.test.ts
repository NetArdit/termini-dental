import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, newClinic, newDentist, patientInput, startApp, type TestApp } from "./helpers";

// Reviews of dentists: written by a patient through their own private link, after a visit that took place,
// once per visit; shown on the public pages only after the administrator has published them, and never with
// the patient's name.

const NOW = "2026-10-12T08:00:00Z";
const WED_0900 = "2026-10-14T07:00:00.000Z";
const WED_AFTER = "2026-10-14T12:00:00Z";

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
type Clinic = Awaited<ReturnType<typeof newClinic>>;

/** A patient books online, comes, and the dentist writes the report: a visit that took place. */
async function visited(c: Clinic, opts: { startsAt?: string; dentistId?: number | null } = {}) {
  app.setNow(NOW);
  const who = patientInput({ fullName: "Blerim Hoxha" });
  const booked = await pub().post("/api/public/book", { serviceId: c.checkup.id, dentistId: opts.dentistId ?? null, startsAt: opts.startsAt ?? WED_0900, ...who });
  expect(booked.status).toBe(201);
  const token = booked.data.token as string;
  const id = (await app.ctx.db.query<{ id: number }>("SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE lower(p.email) = $1", [who.email]))[0]!.id;
  app.setNow(WED_AFTER);
  expect((await c.admin.put(`/api/appointments/${id}/report`, { workDone: "Kontroll i rregullt." })).status).toBe(200);
  return { id, token, secret: { "x-appointment-token": token } };
}
const publicInfo = async () => (await pub().get("/api/public/clinic")).data;

describe("writing a review", () => {
  it("is offered after the visit, takes stars and an optional comment, once", async () => {
    const c = await newClinic(app);
    const v = await visited(c);
    const before = (await pub().get("/api/public/appointment", v.secret)).data;
    expect([before.canReview, before.review]).toEqual([true, null]);
    // After the visit the link says which visit it was, and no longer who the patient is or what was paid.
    expect(before.appointment.dentistName).toBe("Dr. Arta Krasniqi");
    expect([before.appointment.patientName, before.appointment.deposit]).toEqual([null, null]);
    expect(JSON.stringify(before)).not.toContain("Blerim");

    const sent = await pub().post("/api/public/appointment/review", { rating: 5, comment: "  Shumë e kujdesshme, më shpjegoi çdo hap.  " }, v.secret);
    expect(sent.status).toBe(201);
    const after = (await pub().get("/api/public/appointment", v.secret)).data;
    expect(after.canReview).toBe(false);
    expect(after.review).toEqual({ rating: 5, comment: "Shumë e kujdesshme, më shpjegoi çdo hap." });

    const again = await pub().post("/api/public/appointment/review", { rating: 1, comment: "Ndryshova mendje." }, v.secret);
    expect(again.status).toBe(409);
    expect((await app.ctx.db.query<{ rating: number }>("SELECT rating FROM dentist_reviews WHERE appointment_id = $1", [v.id])).map((r) => r.rating)).toEqual([5]);
  });

  it("stars alone are enough; a comment is never required", async () => {
    const c = await newClinic(app);
    const v = await visited(c);
    expect((await pub().post("/api/public/appointment/review", { rating: 4 }, v.secret)).status).toBe(201);
    expect((await app.ctx.db.query<{ comment: string | null }>("SELECT comment FROM dentist_reviews WHERE appointment_id = $1", [v.id]))[0]!.comment).toBeNull();
    const w = await visited(c, { startsAt: "2026-10-14T08:00:00.000Z" });
    expect((await pub().post("/api/public/appointment/review", { rating: 3, comment: "   " }, w.secret)).status).toBe(201);
    expect((await app.ctx.db.query<{ comment: string | null }>("SELECT comment FROM dentist_reviews WHERE appointment_id = $1", [w.id]))[0]!.comment).toBeNull();
  });

  it("is refused before the visit, without the link, with stars out of range, with a comment too long, or with anything extra", async () => {
    const c = await newClinic(app);
    const who = patientInput();
    const booked = await pub().post("/api/public/book", { serviceId: c.checkup.id, dentistId: null, startsAt: WED_0900, ...who });
    const secret = { "x-appointment-token": booked.data.token as string };
    expect((await pub().post("/api/public/appointment/review", { rating: 5 }, secret)).status).toBe(409);
    expect((await pub().get("/api/public/appointment", secret)).data.canReview).toBe(false);

    const v = await visited(c, { startsAt: "2026-10-14T08:00:00.000Z" });
    expect((await pub().post("/api/public/appointment/review", { rating: 5 })).status).toBe(404);
    expect((await pub().post("/api/public/appointment/review", { rating: 5 }, { "x-appointment-token": "x".repeat(43) })).status).toBe(404);
    for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: "5" }, {}, { rating: 5, comment: "x".repeat(601) }, { rating: 5, dentistId: 1 }, { rating: 5, status: "published" }]) {
      expect((await pub().post("/api/public/appointment/review", bad, v.secret)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await app.ctx.db.query("SELECT 1 FROM dentist_reviews")).length).toBe(0);
  });

  it("a cancelled appointment cannot be reviewed: its link is dead", async () => {
    const c = await newClinic(app);
    const who = patientInput();
    const booked = await pub().post("/api/public/book", { serviceId: c.checkup.id, dentistId: null, startsAt: WED_0900, ...who });
    const secret = { "x-appointment-token": booked.data.token as string };
    await pub().post("/api/public/appointment/cancel", {}, secret);
    expect((await pub().post("/api/public/appointment/review", { rating: 1, comment: "Nuk erdha fare." }, secret)).status).toBe(404);
  });
});

describe("what the public sees", () => {
  it("nothing until the administrator publishes; then the dentist's average and the comment, without the patient's name", async () => {
    const c = await newClinic(app);
    const v = await visited(c);
    await pub().post("/api/public/appointment/review", { rating: 5, comment: "Pa dhimbje fare." }, v.secret);
    let info = await publicInfo();
    expect(info.reviews).toEqual([]);
    expect(info.dentists[0].rating).toBeNull();

    const pending = (await c.admin.get("/api/reviews")).data.reviews;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ rating: 5, comment: "Pa dhimbje fare.", status: "pending", patientName: "Blerim Hoxha", dentistName: "Dr. Arta Krasniqi" });
    expect((await c.admin.patch(`/api/reviews/${pending[0].id}`, { status: "published" })).status).toBe(200);

    info = await publicInfo();
    expect(info.dentists[0].rating).toEqual({ average: 5, count: 1 });
    expect(info.reviews).toHaveLength(1);
    expect(info.reviews[0]).toMatchObject({ rating: 5, comment: "Pa dhimbje fare.", dentistName: "Dr. Arta Krasniqi" });
    expect(JSON.stringify(info)).not.toContain("Blerim");
    expect(JSON.stringify(info)).not.toContain("Hoxha");

    // Hidden again: gone from the page and from the average.
    await c.admin.patch(`/api/reviews/${pending[0].id}`, { status: "hidden" });
    info = await publicInfo();
    expect([info.reviews, info.dentists[0].rating]).toEqual([[], null]);
    expect((await app.ctx.db.query("SELECT 1 FROM audit_log WHERE action IN ('review_submitted', 'review_published', 'review_hidden')")).length).toBe(3);
  });

  it("each dentist has their own average; stars without a comment count but are not listed", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const a1 = await visited(c, { startsAt: "2026-10-14T07:00:00.000Z", dentistId: c.adminId });
    const a2 = await visited(c, { startsAt: "2026-10-14T08:00:00.000Z", dentistId: c.adminId });
    const b1 = await visited(c, { startsAt: "2026-10-14T07:00:00.000Z", dentistId: besnik.id });
    await pub().post("/api/public/appointment/review", { rating: 5, comment: "Shkëlqyeshëm." }, a1.secret);
    await pub().post("/api/public/appointment/review", { rating: 4 }, a2.secret);
    await pub().post("/api/public/appointment/review", { rating: 2, comment: "Prita gjatë." }, b1.secret);
    for (const r of (await c.admin.get("/api/reviews")).data.reviews) await c.admin.patch(`/api/reviews/${r.id}`, { status: "published" });

    const info = await publicInfo();
    const rating = (id: number) => info.dentists.find((d: { id: number }) => d.id === id).rating;
    expect(rating(c.adminId)).toEqual({ average: 4.5, count: 2 });
    expect(rating(besnik.id)).toEqual({ average: 2, count: 1 });
    expect(info.reviews.map((v: { comment: string }) => v.comment).sort()).toEqual(["Prita gjatë.", "Shkëlqyeshëm."]);
  });
});

describe("who decides", () => {
  it("only the administrator sees the list and publishes; a dentist cannot publish praise of themselves", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const v = await visited(c);
    await pub().post("/api/public/appointment/review", { rating: 5, comment: "Faleminderit." }, v.secret);
    const id = (await c.admin.get("/api/reviews")).data.reviews[0].id;
    expect((await besnik.client.get("/api/reviews")).status).toBe(403);
    expect((await besnik.client.patch(`/api/reviews/${id}`, { status: "published" })).status).toBe(403);
    expect((await pub().patch(`/api/reviews/${id}`, { status: "published" })).status).toBe(401);
    expect((await c.admin.patch(`/api/reviews/${id}`, { status: "pending" })).status).toBe(400);
    expect((await c.admin.patch(`/api/reviews/${id}`, { status: "published", rating: 1 })).status).toBe(400);
    expect((await c.admin.patch("/api/reviews/99999999", { status: "published" })).status).toBe(404);
    expect((await publicInfo()).reviews).toEqual([]);
  });

  it("an administrator who is the dentist reviewed leaves the publishing to the other administrator, when there is one", async () => {
    const c = await newClinic(app);
    const v = await visited(c);
    await pub().post("/api/public/appointment/review", { rating: 5, comment: "E shkëlqyer." }, v.secret);
    const id = (await c.admin.get("/api/reviews")).data.reviews[0].id;
    const created = await c.admin.post("/api/staff", { fullName: "Dona Berisha", email: "dona@klinika.test", password: "fjalekalimi3", role: "admin" });
    expect(created.status).toBe(201);

    // The review is about the first administrator's own work.
    const own = await c.admin.patch(`/api/reviews/${id}`, { status: "published" });
    expect(own.status).toBe(403);
    expect((await publicInfo()).reviews).toEqual([]);
    // Hiding it is not praise of oneself: allowed.
    expect((await c.admin.patch(`/api/reviews/${id}`, { status: "hidden" })).status).toBe(200);

    const dona = pub();
    expect((await dona.post("/api/auth/login", { email: "dona@klinika.test", password: "fjalekalimi3" })).status).toBe(200);
    expect((await dona.patch(`/api/reviews/${id}`, { status: "published" })).status).toBe(200);
    expect((await publicInfo()).reviews).toHaveLength(1);
  });

  it("the database keeps one review per visit and stars from one to five, whoever writes", async () => {
    const c = await newClinic(app);
    const v = await visited(c);
    await pub().post("/api/public/appointment/review", { rating: 5 }, v.secret);
    await expect(app.ctx.db.query("INSERT INTO dentist_reviews (clinic_id, appointment_id, dentist_id, rating) VALUES ($1, $2, $3, 5)", [c.clinic.id, v.id, c.adminId])).rejects.toThrow();
    await expect(app.ctx.db.query("UPDATE dentist_reviews SET rating = 6 WHERE appointment_id = $1", [v.id])).rejects.toThrow();
    await expect(app.ctx.db.query("UPDATE dentist_reviews SET status = 'featured' WHERE appointment_id = $1", [v.id])).rejects.toThrow();
  });
});
