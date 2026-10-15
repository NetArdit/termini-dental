import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportBackup } from "../src/server/backup";
import { BootstrapError, setPasswordByHand } from "../src/server/bootstrap";
import { client, newClinic, newDentist, startApp, type TestApp } from "./helpers";

// A member of staff who forgot their password asks for a link and sets a new one. Nothing in the answers
// says who has an account; the link works once and for half an hour; only its hash is stored.

const NOW = "2026-10-12T08:00:00Z";
const LINK = /\/fjalekalimi#([A-Za-z0-9_-]{20,})/;

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
beforeEach(() => {
  app.setNow(NOW);
  app.failMail.value = false;
});

const anybody = () => client(app.base);
const linkTo = (email: string) => {
  const mail = [...app.sent].reverse().find((m) => m.to === email && LINK.test(m.text));
  return mail ? LINK.exec(mail.text)![1]! : null;
};
const resets = () => app.ctx.db.query<{ token_hash: string; used_at: Date | null; expires_at: Date }>("SELECT token_hash, used_at, expires_at FROM password_resets ORDER BY id");

describe("asking for a link", () => {
  it("answers the same for an account, an unknown address and a closed account; only the account gets mail", async () => {
    const { admin, email } = await newClinic(app);
    const closed = await newDentist(app, admin);
    await admin.patch(`/api/staff/${closed.id}`, { isActive: false });
    const before = app.sent.length;
    const known = await anybody().post("/api/auth/forgot", { email });
    const unknown = await anybody().post("/api/auth/forgot", { email: "askush@example.test" });
    const inactive = await anybody().post("/api/auth/forgot", { email: closed.email });
    expect([known.status, known.data]).toEqual([200, { ok: true }]);
    expect([unknown.status, unknown.data]).toEqual([known.status, known.data]);
    expect([inactive.status, inactive.data]).toEqual([known.status, known.data]);
    expect(app.sent.slice(before).map((m) => m.to)).toEqual([email]);
    expect(await resets()).toHaveLength(1);
  });

  it("stores only a hash of the link, with half an hour to run; the mail carries the link and nothing else keeps it", async () => {
    const { email, clinic } = await newClinic(app);
    await anybody().post("/api/auth/forgot", { email: `  ${email.toUpperCase()} ` });
    const token = linkTo(email)!;
    expect(token.length).toBeGreaterThanOrEqual(43);
    const [row] = await resets();
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.token_hash).not.toContain(token);
    expect(new Date(row!.expires_at).getTime() - Date.parse(NOW)).toBe(30 * 60 * 1000);
    const everything = JSON.stringify([
      await app.ctx.db.query("SELECT * FROM password_resets"),
      await app.ctx.db.query("SELECT * FROM audit_log WHERE clinic_id = $1", [clinic.id]),
      await app.ctx.db.query("SELECT * FROM email_log"),
      await exportBackup(app.ctx.db, app.ctx.now()),
      app.logs,
    ]);
    expect(everything).not.toContain(token);
    const audit = await app.ctx.db.query<{ meta: { delivery: string } }>("SELECT meta FROM audit_log WHERE action = 'password_reset_requested'");
    expect(audit.map((a) => a.meta)).toEqual([{ delivery: "sent" }]);
  });

  it("asking again ends the earlier link", async () => {
    const { email } = await newClinic(app);
    await anybody().post("/api/auth/forgot", { email });
    const first = linkTo(email)!;
    await anybody().post("/api/auth/forgot", { email });
    const second = linkTo(email)!;
    expect(second).not.toBe(first);
    expect((await anybody().post("/api/auth/reset", { token: first, password: "fjalekalim-i-ri-1" })).status).toBe(400);
    expect((await anybody().post("/api/auth/reset", { token: second, password: "fjalekalim-i-ri-1" })).status).toBe(200);
  });

  it("a mail server that refuses: the answer is still the same, no usable link is left behind, and it is on record", async () => {
    const { email } = await newClinic(app);
    app.failMail.value = true;
    const res = await anybody().post("/api/auth/forgot", { email });
    expect([res.status, res.data]).toEqual([200, { ok: true }]);
    const rows = await resets();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.used_at).not.toBeNull();
    expect((await app.ctx.db.query<{ meta: { delivery: string } }>("SELECT meta FROM audit_log WHERE action = 'password_reset_requested'")).map((a) => a.meta)).toEqual([{ delivery: "refused" }]);
  });

  it("a mail server that has not answered by the time the request must: the link stays good, because the mail may still arrive", async () => {
    const { email } = await newClinic(app);
    // The mail server takes far longer than the request may wait, however far away the database is.
    app.mailDelay.ms = 3000;
    const res = await anybody().post("/api/auth/forgot", { email });
    expect([res.status, res.data]).toEqual([200, { ok: true }]);
    // Answered, and the mail has not gone out yet.
    expect(linkTo(email)).toBeNull();
    expect((await app.ctx.db.query<{ meta: { delivery: string } }>("SELECT meta FROM audit_log WHERE action = 'password_reset_requested'")).map((a) => a.meta)).toEqual([{ delivery: "unknown" }]);
    const rows = await resets();
    expect(rows.map((r) => r.used_at)).toEqual([null]);
    // The mail arrives later, and its link works.
    for (let i = 0; i < 80 && !linkTo(email); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    app.mailDelay.ms = 0;
    expect((await anybody().post("/api/auth/reset", { token: linkTo(email)!, password: "fjalekalim-i-ri-1" })).status).toBe(200);
  }, 20_000);

  it("takes the same time to answer whether the address has an account or not", async () => {
    const { email } = await newClinic(app);
    // Long enough for the work of a known address to fit inside it also when the database is far away.
    app.ctx.resetAnswerMs = 2500;
    app.mailDelay.ms = 150;
    try {
      const time = async (address: string) => {
        const started = Date.now();
        await anybody().post("/api/auth/forgot", { email: address });
        return Date.now() - started;
      };
      const known = await time(email);
      const unknown = await time("askush@example.test");
      // Both wait for the same moment. (Without that, the first would take the mail server's 150 ms and
      // the second next to nothing.)
      expect(known).toBeGreaterThanOrEqual(2450);
      expect(unknown).toBeGreaterThanOrEqual(2450);
      expect(Math.abs(known - unknown)).toBeLessThan(300);
    } finally {
      app.ctx.resetAnswerMs = 120;
      app.mailDelay.ms = 0;
    }
  }, 20_000);

  it("asked twice at the same moment, one link is left open", async () => {
    const { email } = await newClinic(app);
    await Promise.all([anybody().post("/api/auth/forgot", { email }), anybody().post("/api/auth/forgot", { email })]);
    const rows = await resets();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.used_at === null)).toHaveLength(1);
  });

  it("without a mail server it says so to everybody alike, and promises nothing", async () => {
    const { email } = await newClinic(app);
    const mailer = app.ctx.mailer;
    app.ctx.mailer = null;
    try {
      const known = await anybody().post("/api/auth/forgot", { email });
      const unknown = await anybody().post("/api/auth/forgot", { email: "askush@example.test" });
      expect(known.status).toBe(503);
      expect([unknown.status, unknown.data]).toEqual([known.status, known.data]);
      expect(await resets()).toHaveLength(0);
    } finally {
      app.ctx.mailer = mailer;
    }
  });

  it("cannot be used to flood a mailbox or to hammer the server", async () => {
    const { email } = await newClinic(app);
    const before = app.sent.length;
    const one = anybody();
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await one.post("/api/auth/forgot", { email })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(app.sent.length - before).toBe(3);
    // Other addresses from the same sender are counted too.
    const others = [];
    for (let i = 0; i < 9; i++) others.push((await one.post("/api/auth/forgot", { email: `tjeter${i}@example.test` })).status);
    expect(others.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect((await one.post("/api/auth/forgot", { email: "jo-email" })).status).toBe(400);
  });
});

describe("using the link", () => {
  it("sets the new password once, signs the person out everywhere, and the old password is dead", async () => {
    const { admin, email } = await newClinic(app);
    const elsewhere = anybody();
    expect((await elsewhere.post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(200);
    await anybody().post("/api/auth/forgot", { email });
    const token = linkTo(email)!;

    const done = await anybody().post("/api/auth/reset", { token, password: "fjalekalim-i-ri-1" });
    expect([done.status, done.data]).toEqual([200, { ok: true }]);
    expect((await admin.get("/api/auth/me")).status).toBe(401);
    expect((await elsewhere.get("/api/auth/me")).status).toBe(401);
    expect((await anybody().post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(401);
    expect((await anybody().post("/api/auth/login", { email, password: "fjalekalim-i-ri-1" })).status).toBe(200);
    // Once.
    expect((await anybody().post("/api/auth/reset", { token, password: "nje-tjeter-12345" })).status).toBe(400);
    expect((await anybody().post("/api/auth/login", { email, password: "nje-tjeter-12345" })).status).toBe(401);
    expect((await app.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'password_reset_completed'")).length).toBe(1);
  });

  it("does not work after half an hour, for an account closed meanwhile, with a wrong secret, or with a short password", async () => {
    const { admin, email } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    await anybody().post("/api/auth/forgot", { email });
    const late = linkTo(email)!;
    app.setNow("2026-10-12T08:30:01Z");
    const expired = await anybody().post("/api/auth/reset", { token: late, password: "fjalekalim-i-ri-1" });
    expect(expired.status).toBe(400);

    app.setNow("2026-10-12T09:40:00Z");
    await anybody().post("/api/auth/forgot", { email: besnik.email });
    const his = linkTo(besnik.email)!;
    await admin.patch(`/api/staff/${besnik.id}`, { isActive: false });
    const closed = await anybody().post("/api/auth/reset", { token: his, password: "fjalekalim-i-ri-1" });
    const wrong = await anybody().post("/api/auth/reset", { token: "x".repeat(43), password: "fjalekalim-i-ri-1" });
    // One answer for all three: nothing to learn from it.
    expect([closed.status, closed.data]).toEqual([expired.status, expired.data]);
    expect([wrong.status, wrong.data]).toEqual([expired.status, expired.data]);

    await anybody().post("/api/auth/forgot", { email });
    const fresh = linkTo(email)!;
    expect((await anybody().post("/api/auth/reset", { token: fresh, password: "short" })).status).toBe(400);
    // The link survived the refusal of a bad password.
    expect((await anybody().post("/api/auth/reset", { token: fresh, password: "fjalekalim-i-ri-1" })).status).toBe(200);
  });

  it("used twice at the same moment, it sets one password", async () => {
    const { email } = await newClinic(app);
    await anybody().post("/api/auth/forgot", { email });
    const token = linkTo(email)!;
    const both = await Promise.all([anybody().post("/api/auth/reset", { token, password: "fjalekalim-nje-1" }), anybody().post("/api/auth/reset", { token, password: "fjalekalim-dy-22" })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = both[0]!.status === 200 ? "fjalekalim-nje-1" : "fjalekalim-dy-22";
    const loser = winner === "fjalekalim-nje-1" ? "fjalekalim-dy-22" : "fjalekalim-nje-1";
    expect((await anybody().post("/api/auth/login", { email, password: winner })).status).toBe(200);
    expect((await anybody().post("/api/auth/login", { email, password: loser })).status).toBe(401);
  });

  it("guessing secrets is slowed down", async () => {
    await newClinic(app);
    const one = anybody();
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await one.post("/api/auth/reset", { token: `${"y".repeat(42)}${i % 10}`, password: "fjalekalim-i-ri-1" })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("the sole administrator who was locked out by failed sign-ins gets back in with the new password", async () => {
    const { email } = await newClinic(app);
    const one = anybody();
    for (let i = 0; i < 8; i++) await one.post("/api/auth/login", { email, password: "gabim-gabim" });
    expect((await one.post("/api/auth/login", { email, password: "fjalekalimi1" })).status).toBe(429);
    await one.post("/api/auth/forgot", { email });
    expect((await one.post("/api/auth/reset", { token: linkTo(email)!, password: "fjalekalim-i-ri-1" })).status).toBe(200);
    expect((await one.post("/api/auth/login", { email, password: "fjalekalim-i-ri-1" })).status).toBe(200);
  });
});

describe("by hand, when no link can be sent", () => {
  it("sets the password of the person named, signs them out, ends their open links, and touches nobody else", async () => {
    const { admin, email } = await newClinic(app);
    const besnik = await newDentist(app, admin);
    await anybody().post("/api/auth/forgot", { email });
    const open = linkTo(email)!;
    const others = (await app.ctx.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", [besnik.email]))[0]!.password_hash;

    expect(await setPasswordByHand(app.ctx.db, `  ${email.toUpperCase()}`, "vendosur-me-dore-1")).toEqual({ fullName: "Dr. Arta Krasniqi" });
    expect((await admin.get("/api/auth/me")).status).toBe(401);
    expect((await anybody().post("/api/auth/login", { email, password: "vendosur-me-dore-1" })).status).toBe(200);
    expect((await anybody().post("/api/auth/reset", { token: open, password: "fjalekalim-i-ri-1" })).status).toBe(400);
    expect((await app.ctx.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", [besnik.email]))[0]!.password_hash).toBe(others);
    expect((await besnik.client.get("/api/auth/me")).status).toBe(200);
    expect((await app.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'password_set_from_command_line'")).length).toBe(1);

    await expect(setPasswordByHand(app.ctx.db, "askush@example.test", "vendosur-me-dore-1")).rejects.toThrow(BootstrapError);
    await expect(setPasswordByHand(app.ctx.db, email, "short")).rejects.toThrow(BootstrapError);
  });
});
