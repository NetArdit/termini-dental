import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportBackup, restoreBackup } from "../src/server/backup";
import { loadMigrations } from "../src/server/db";
import { retryPendingEmails } from "../src/server/mail";
import { client, newClinic, patientInput, startApp, type TestApp } from "./helpers";

// The patient's private link opens the appointment and can cancel it. It must exist in two places only: on
// the patient's screen and in the patient's mailbox. Not in the database, not in what staff see, not in a
// backup (audit H1).

const NOW = "2026-10-12T08:00:00Z";
const WED_0900 = "2026-10-14T07:00:00.000Z";
const LINK = /\/termin#([A-Za-z0-9_-]{20,})/;

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
const view = (token: string) => pub().get("/api/public/appointment", { "x-appointment-token": token });
const everythingStored = async (clinicId: number) =>
  JSON.stringify([
    await app.ctx.db.query("SELECT * FROM email_log WHERE clinic_id = $1", [clinicId]),
    await app.ctx.db.query("SELECT * FROM appointments WHERE clinic_id = $1", [clinicId]),
    await app.ctx.db.query("SELECT * FROM audit_log WHERE clinic_id = $1", [clinicId]),
    await app.ctx.db.query("SELECT * FROM booking_requests WHERE clinic_id = $1", [clinicId]),
  ]);
const linkIn = (text: string) => LINK.exec(text)![1]!;

async function book(_clinic: { id: number }, checkupId: number, overrides: Record<string, unknown> = {}) {
  const who = patientInput(overrides);
  const res = await pub().post("/api/public/book", { serviceId: checkupId, dentistId: null, startsAt: WED_0900, ...who });
  return { res, who };
}

describe("the patient's private link is not written down", () => {
  it("a confirmation that goes out at once: the mail has the link, the database and the staff's view do not", async () => {
    const { admin, clinic, checkup } = await newClinic(app);
    const before = app.sent.length;
    const { res, who } = await book(clinic, checkup.id);
    expect(res.status).toBe(201);
    const token = res.data.token as string;

    const mail = app.sent[before]!;
    expect(mail.to).toBe(who.email);
    expect(linkIn(mail.text)).toBe(token);
    expect(mail.text).not.toContain("{{token}}");
    expect((await view(token)).status).toBe(200);

    const stored = await everythingStored(clinic.id);
    expect(stored).not.toContain(token);
    expect(stored).toContain("/termin#{{token}}");

    const seen = (await admin.get("/api/emails")).data.emails as Array<{ to: string; body: string }>;
    const mine = seen.find((e) => e.to === who.email)!;
    expect(mine.body).not.toContain(token);
    expect(mine.body).not.toContain("{{token}}");
    expect(mine.body).not.toContain("/termin#");
    expect(mine.body).toContain("[linku privat i pacientit]");
  });

  it("a confirmation the mail server refused, sent again by staff: a new link goes out, both links work, neither is stored, a cancellation ends both", async () => {
    const { admin, clinic, checkup } = await newClinic(app);
    app.failMail.value = true;
    const { res, who } = await book(clinic, checkup.id);
    expect(res.data.emailStatus).toBe("failed");
    const onScreen = res.data.token as string;
    app.failMail.value = false;

    const row = ((await admin.get("/api/emails")).data.emails as Array<{ id: number; to: string; kind: string }>).find((e) => e.to === who.email && e.kind === "booking_confirmation")!;
    const before = app.sent.length;
    expect((await admin.post(`/api/emails/${row.id}/resend`)).data.status).toBe("accepted");
    const inMail = linkIn(app.sent[before]!.text);
    expect(inMail).not.toBe(onScreen);
    expect(inMail.length).toBeGreaterThanOrEqual(43);

    expect((await view(onScreen)).status).toBe(200);
    expect((await view(inMail)).status).toBe(200);
    const stored = await everythingStored(clinic.id);
    expect(stored).not.toContain(onScreen);
    expect(stored).not.toContain(inMail);
    // What the staff's "send again" answered and logged does not carry it either.
    expect(JSON.stringify((await admin.get("/api/emails")).data)).not.toContain(inMail);

    expect((await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": inMail })).status).toBe(200);
    expect((await view(onScreen)).status).toBe(404);
    expect((await view(inMail)).status).toBe(404);
  });

  it("a confirmation retried by the housekeeping gets a link of its own each time, and every link that was mailed keeps working", async () => {
    const { clinic, checkup } = await newClinic(app);
    app.failMail.value = true;
    const { res, who } = await book(clinic, checkup.id);
    const onScreen = res.data.token as string;
    // The retry is recorded as refused too, but its mail did arrive: the server answered wrongly after taking it.
    const hashes = async () => (await app.ctx.db.query<{ mail_token_hashes: string[] }>("SELECT mail_token_hashes FROM appointments WHERE clinic_id = $1", [clinic.id]))[0]!.mail_token_hashes;
    const arrived: string[] = [];
    const send = app.ctx.mailer!.send;
    app.ctx.mailer!.send = async (message) => {
      arrived.push(message.text);
      throw new Error("answer lost");
    };
    app.setNow("2026-10-12T08:20:00Z");
    expect(await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now())).toBe(1);
    app.ctx.mailer!.send = send;
    const earlier = linkIn(arrived[0]!);
    expect(await hashes()).toHaveLength(1);
    expect((await hashes())[0]).toMatch(/^[0-9a-f]{64}$/);
    app.failMail.value = false;
    app.setNow("2026-10-12T08:40:00Z");
    const before = app.sent.length;
    expect(await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now())).toBe(1);
    const mail = app.sent[before]!;
    expect(mail.to).toBe(who.email);
    const inMail = linkIn(mail.text);
    expect(inMail).not.toBe(earlier);
    expect(new Set(await hashes()).size).toBe(2);
    // The link on the screen, the link of the mail that "failed" and the link of the mail that went through.
    for (const link of [onScreen, earlier, inMail]) expect((await view(link)).status).toBe(200);
    const stored = await everythingStored(clinic.id);
    expect(stored).not.toContain(inMail);
    expect(stored).not.toContain(earlier);
    // One cancellation ends all three.
    expect((await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": earlier })).status).toBe(200);
    for (const link of [onScreen, earlier, inMail]) expect((await view(link)).status).toBe(404);
    expect(await hashes()).toEqual([]);
  });

  it("an appointment made by staff: the patient's mail has a link, nothing stored has", async () => {
    const { admin, adminId, clinic, checkup } = await newClinic(app);
    const to = `lokal-${Date.now()}@example.test`;
    const before = app.sent.length;
    const made = await admin.post("/api/appointments", { dentistId: adminId, serviceId: checkup.id, startsAt: WED_0900, newPatient: { fullName: "Pacient Lokal", phone: "044 555 666", email: to } });
    expect(made.status).toBe(201);
    const mail = app.sent.slice(before).find((m) => m.to === to)!;
    const inMail = linkIn(mail.text);
    expect((await view(inMail)).status).toBe(200);
    expect(await everythingStored(clinic.id)).not.toContain(inMail);
    expect(JSON.stringify(made.data)).not.toContain(inMail);
  });

  it("a backup holds no link, and says nothing that opens an appointment", async () => {
    const { clinic, checkup } = await newClinic(app);
    app.failMail.value = true;
    const { res } = await book(clinic, checkup.id);
    app.failMail.value = false;
    app.setNow("2026-10-12T08:20:00Z");
    const before = app.sent.length;
    await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now());
    const inMail = linkIn(app.sent[before]!.text);
    const backup = JSON.stringify(await exportBackup(app.ctx.db, app.ctx.now()));
    expect(backup).not.toContain(res.data.token as string);
    expect(backup).not.toContain(inMail);
    expect(backup).not.toMatch(LINK);
    expect(backup).toContain("mail_token_hashes");

    // Restored into an empty database, both links still open the appointment, and nothing readable came along.
    const second = await startApp("2026-10-12T08:20:00Z");
    try {
      await restoreBackup(second.ctx.db, JSON.parse(backup));
      const there = (token: string) => client(second.base).get("/api/public/appointment", { "x-appointment-token": token });
      expect((await there(res.data.token as string)).status).toBe(200);
      expect((await there(inMail)).status).toBe(200);
      expect((await there("x".repeat(43))).status).toBe(404);
      const rows = JSON.stringify(await second.ctx.db.query("SELECT * FROM email_log"));
      expect(rows).not.toContain(inMail);
      expect(rows).toContain("{{token}}");
    } finally {
      await second.close();
    }
  });

  it("an attempt that is under way when the appointment is cancelled cannot bring a link back to life", async () => {
    const { clinic, checkup } = await newClinic(app);
    app.failMail.value = true;
    const { res } = await book(clinic, checkup.id, {});
    app.failMail.value = false;
    const onScreen = res.data.token as string;
    // The mail server is slow; while the retry waits for it, the patient cancels.
    const send = app.ctx.mailer!.send;
    let inFlight = "";
    app.ctx.mailer!.send = async (message) => {
      inFlight = linkIn(message.text);
      expect((await pub().post("/api/public/appointment/cancel", {}, { "x-appointment-token": onScreen })).status).toBe(200);
      return send(message);
    };
    app.setNow("2026-10-12T08:20:00Z");
    await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now());
    app.ctx.mailer!.send = send;
    expect(inFlight).not.toBe("");
    expect((await view(inFlight)).status).toBe(404);
    expect((await view(onScreen)).status).toBe(404);
    // And nothing later makes one: the confirmation of a cancelled appointment is not sent again.
    app.setNow("2026-10-12T08:40:00Z");
    await retryPendingEmails(app.ctx.db, app.ctx.mailer, app.ctx.now());
    const row = (await app.ctx.db.query<{ mail_token_hashes: string[]; token_hash: string | null }>("SELECT mail_token_hashes, token_hash FROM appointments WHERE clinic_id = $1", [clinic.id]))[0]!;
    expect(row).toEqual({ mail_token_hashes: [], token_hash: null });
  });

  it("messages stored before this change lose their link when the migration runs, and it can run twice", async () => {
    const { clinic, checkup } = await newClinic(app);
    const { res, who } = await book(clinic, checkup.id);
    const old = `Përshëndetje,\nPër ta parë ose anuluar terminin: https://klinika.example/termin#${res.data.token}\nFaleminderit.`;
    await app.ctx.db.query("UPDATE email_log SET body = $2 WHERE clinic_id = $1", [clinic.id, old]);
    const migration = loadMigrations().find((m) => m.version === 5)!;
    // The file's statements, one at a time, as written.
    const statements = migration.sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    for (let i = 0; i < 2; i++) for (const statement of statements) await app.ctx.db.query(statement);
    const body = (await app.ctx.db.query<{ body: string }>("SELECT body FROM email_log WHERE clinic_id = $1 AND to_email = $2", [clinic.id, who.email]))[0]!.body;
    expect(body).toBe(old.replace(res.data.token as string, "{{token}}"));
    // The link the patient already has still opens the appointment.
    expect((await view(res.data.token as string)).status).toBe(200);
  });

  it("a message about an appointment that was cancelled meanwhile goes out without a link that would not work", async () => {
    const { admin, adminId, clinic, checkup } = await newClinic(app);
    const to = `anuluar-${Date.now()}@example.test`;
    app.failMail.value = true;
    const made = await admin.post("/api/appointments", { dentistId: adminId, serviceId: checkup.id, startsAt: WED_0900, newPatient: { fullName: "Pacient Anuluar", phone: "044 777 888", email: to } });
    await admin.post(`/api/appointments/${made.data.id}/cancel`, { reason: "Ndryshim orari" });
    app.failMail.value = false;
    const stored = await app.ctx.db.query<{ kind: string; body: string }>("SELECT kind, body FROM email_log WHERE clinic_id = $1 AND to_email = $2 ORDER BY id", [clinic.id, to]);
    expect(stored.map((s) => s.kind)).toEqual(["booking_confirmation", "cancelled_by_clinic"]);
    expect(stored[1]!.body).not.toContain("{{token}}");
    // The confirmation is no longer worth sending and staff cannot push it out.
    const rows = (await admin.get("/api/emails")).data.emails as Array<{ id: number; to: string; kind: string; canResend: boolean }>;
    const confirmation = rows.find((e) => e.to === to && e.kind === "booking_confirmation")!;
    expect(confirmation.canResend).toBe(false);
    expect((await admin.post(`/api/emails/${confirmation.id}/resend`)).status).toBe(409);
    expect((await app.ctx.db.query<{ mail_token_hashes: string[] }>("SELECT mail_token_hashes FROM appointments WHERE id = $1", [made.data.id]))[0]!.mail_token_hashes).toEqual([]);
  });
});
