import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportBackup } from "../src/server/backup";
import { brandOf, cardProblems, formatExpiry, formatNumber, luhn } from "../src/web/src/lib/card";
import { client, newClinic, patientInput, startApp, type TestApp } from "./helpers";

// The 15 euro deposit of an online booking, as a demonstration: the page has a card form that behaves like a
// real one, nothing is charged, and nothing about a card ever reaches the server. An appointment records
// only "demo, 1500, EUR" and what the dentist takes off the bill.

const NOW = "2026-10-12T08:00:00Z";
const WED_0900 = "2026-10-14T07:00:00.000Z";
const CARD = "4242424242424242";

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
const body = (c: Clinic, extra: Record<string, unknown> = {}) => ({ serviceId: c.checkup.id, dentistId: null, startsAt: WED_0900, ...patientInput(), ...extra });
const appointments = (c: Clinic) =>
  app.ctx.db.query<{ id: number; deposit_mode: string | null; deposit_amount_minor: number | null; deposit_currency: string | null; bill_credit_minor: number }>(
    "SELECT id, deposit_mode, deposit_amount_minor, deposit_currency, bill_credit_minor FROM appointments WHERE clinic_id = $1 ORDER BY id",
    [c.clinic.id],
  );

describe("the deposit on the server", () => {
  it("the booking page is told the amount and that it is a demonstration", async () => {
    await newClinic(app);
    const page = (await pub().get("/api/public/clinic")).data;
    expect(page.clinic.deposit).toEqual({ mode: "demo", amountMinor: 1500, currency: "EUR" });
  });

  it("an online booking records the demonstration deposit and the credit for the bill, and nothing else about a payment", async () => {
    const c = await newClinic(app);
    const res = await pub().post("/api/public/book", body(c));
    expect(res.status).toBe(201);
    expect(await appointments(c)).toEqual([{ id: expect.any(Number), deposit_mode: "demo", deposit_amount_minor: 1500, deposit_currency: "EUR", bill_credit_minor: 1500 }]);
    const columns = (await app.ctx.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema()")).map((r) => r.column_name);
    expect(columns.filter((name) => /card|pan|cvc|cvv|expiry|holder/i.test(name))).toEqual([]);
  });

  it("the patient's page and the dentist's view both show it, marked as a demonstration", async () => {
    const c = await newClinic(app);
    const res = await pub().post("/api/public/book", body(c));
    const mine = (await pub().get("/api/public/appointment", { "x-appointment-token": res.data.token as string })).data.appointment;
    expect(mine.deposit).toEqual({ mode: "demo", amountMinor: 1500, currency: "EUR" });
    const id = (await appointments(c))[0]!.id;
    const seen = (await c.admin.get(`/api/appointments/${id}`)).data.appointment;
    expect(seen.deposit).toEqual({ mode: "demo", amountMinor: 1500, currency: "EUR", billCreditMinor: 1500 });
    const listed = (await c.admin.get("/api/appointments?date=2026-10-14")).data.appointments[0];
    expect(listed.deposit.mode).toBe("demo");
  });

  it("an appointment made by the clinic has no deposit", async () => {
    const c = await newClinic(app);
    const made = await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt: WED_0900, newPatient: { fullName: "Pacient Lokal", phone: "044 111 222" } });
    expect(made.status).toBe(201);
    expect(await appointments(c)).toEqual([{ id: made.data.id, deposit_mode: null, deposit_amount_minor: null, deposit_currency: null, bill_credit_minor: 0 }]);
    expect((await c.admin.get(`/api/appointments/${made.data.id}`)).data.appointment.deposit).toBeNull();
  });

  it("a booking that skipped the deposit step is refused", async () => {
    const c = await newClinic(app);
    const { deposit: _skipped, ...without } = body(c);
    for (const wrong of [without, { ...without, deposit: "paid" }, { ...without, deposit: true }, { ...without, deposit: { mode: "demo" } }]) {
      const res = await pub().post("/api/public/book", wrong);
      expect(res.status).toBe(400);
    }
    expect(await appointments(c)).toEqual([]);
  });

  it("a request that carries anything of a card is refused whole, and the card is nowhere afterwards", async () => {
    const c = await newClinic(app);
    const who = patientInput();
    const smuggled = [
      { cardNumber: CARD },
      { card: { number: CARD, expiry: "12/29", cvc: "123", name: "Arta Krasniqi" } },
      { number: CARD },
      { pan: CARD, cvc: "123" },
      { deposit: "demo", payment: { last4: "4242", brand: "visa" } },
    ];
    for (const extra of smuggled) {
      const res = await pub().post("/api/public/book", { serviceId: c.checkup.id, dentistId: null, startsAt: WED_0900, ...who, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      // The refusal does not repeat what was sent.
      expect(JSON.stringify(res.data)).not.toContain(CARD);
    }
    expect(await appointments(c)).toEqual([]);
    const everywhere = JSON.stringify([
      await exportBackup(app.ctx.db, app.ctx.now()),
      await app.ctx.db.query("SELECT * FROM audit_log"),
      await app.ctx.db.query("SELECT * FROM email_log"),
      await app.ctx.db.query("SELECT * FROM booking_requests"),
      app.logs,
    ]);
    expect(everywhere).not.toContain(CARD);
    expect(everywhere).not.toContain("4242 4242");
    // The same person, without the card, books.
    expect((await pub().post("/api/public/book", { serviceId: c.checkup.id, dentistId: null, startsAt: WED_0900, ...who })).status).toBe(201);
  });

  it("the database refuses a deposit that does not add up", async () => {
    const c = await newClinic(app);
    await pub().post("/api/public/book", body(c));
    const id = (await appointments(c))[0]!.id;
    for (const sql of [
      "UPDATE appointments SET deposit_mode = 'paid' WHERE id = $1",
      "UPDATE appointments SET deposit_amount_minor = NULL WHERE id = $1",
      "UPDATE appointments SET deposit_currency = 'USD' WHERE id = $1",
      "UPDATE appointments SET bill_credit_minor = 2000 WHERE id = $1",
      "UPDATE appointments SET bill_credit_minor = -1 WHERE id = $1",
      "UPDATE appointments SET deposit_mode = NULL WHERE id = $1",
    ]) await expect(app.ctx.db.query(sql, [id]), sql).rejects.toThrow();
    // What is allowed: the dentist's credit can be lowered (part of it used), down to nothing.
    await app.ctx.db.query("UPDATE appointments SET bill_credit_minor = 0 WHERE id = $1", [id]);
  });

  it("a second try of the same booking keeps the one deposit", async () => {
    const c = await newClinic(app);
    const same = body(c);
    await pub().post("/api/public/book", same);
    await pub().post("/api/public/book", same);
    expect(await appointments(c)).toHaveLength(1);
  });
});

describe("the card form's checks, which run in the browser only", () => {
  const now = new Date("2026-10-12T08:00:00Z");
  const good = { number: "4242 4242 4242 4242", name: "Arta Krasniqi", expiry: "12/29", cvc: "123" };

  it("accepts the test card and says what is wrong with others", () => {
    expect(cardProblems(good, now)).toEqual({});
    expect(cardProblems({ number: "", name: "", expiry: "", cvc: "" }, now)).toEqual({ "card.number": "required", "card.name": "required", "card.expiry": "required", "card.cvc": "required" });
    expect(cardProblems({ ...good, number: "4242 4242 4242 4241" }, now)["card.number"]).toBe("invalid");
    expect(cardProblems({ ...good, number: "4242 4242" }, now)["card.number"]).toBe("invalid");
    expect(cardProblems({ ...good, expiry: "09/26" }, now)["card.expiry"]).toBe("expired");
    expect(cardProblems({ ...good, expiry: "10/26" }, now)["card.expiry"]).toBeUndefined();
    expect(cardProblems({ ...good, expiry: "13/29" }, now)["card.expiry"]).toBe("invalid");
    expect(cardProblems({ ...good, cvc: "12" }, now)["card.cvc"]).toBe("invalid");
    expect(cardProblems({ ...good, name: "4242" }, now)["card.name"]).toBe("invalid");
    // American Express: fifteen digits and a code of four.
    expect(cardProblems({ ...good, number: "3782 822463 10005", cvc: "1234" }, now)).toEqual({});
    expect(cardProblems({ ...good, number: "3782 822463 10005", cvc: "123" }, now)["card.cvc"]).toBe("invalid");
  });

  it("recognises the scheme and writes the number and the date as they are printed", () => {
    expect([brandOf("4242"), brandOf("5555"), brandOf("2221"), brandOf("3782"), brandOf("6011")]).toEqual(["visa", "mastercard", "mastercard", "amex", "other"]);
    expect(formatNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(formatNumber("378282246310005")).toBe("3782 822463 10005");
    expect(formatNumber("4242-4242 4242x4242 9999 9999")).toBe("4242 4242 4242 4242 999");
    expect([formatExpiry("1229"), formatExpiry("5"), formatExpiry("12"), formatExpiry("1")]).toEqual(["12/29", "05", "12", "1"]);
    expect([luhn("4242424242424242"), luhn("4242424242424241"), luhn("")]).toEqual([true, false, false]);
  });
});

describe("the booking page's own code", () => {
  const page = readFileSync(new URL("../src/web/src/pages/Book.tsx", import.meta.url), "utf8");

  it("puts nothing of the card into the request, the address or the browser's storage", () => {
    // The one place the page sends a booking: its body is spelled out here, and has no card in it.
    const call = /api\.post<[^>]*>\("\/api\/public\/book", \{([\s\S]*?)\}\);/.exec(page);
    expect(call, "the booking request was not found where it is expected").not.toBeNull();
    // Its fields, without the comments written beside them.
    const sent = call![1]!
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join(" ");
    expect(sent).toContain('deposit: "demo"');
    expect(sent).not.toMatch(/card/i);
    expect(page).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    expect(page).not.toMatch(/console\.(log|info|debug|warn|error)/);
    // Browsers are not invited to fill in a saved card.
    expect(page).not.toMatch(/autoComplete="cc-/);
    // It says that it is a demonstration, before the fields.
    expect(page.indexOf("nuk merret asnjë pagesë")).toBeGreaterThan(-1);
    expect(page.indexOf("nuk merret asnjë pagesë")).toBeLessThan(page.indexOf('label="Numri i kartës"'));
    // Only the test number goes through, and a whole other number is taken out of the page as it is typed.
    expect(page).toContain('const TEST_CARD = "4242424242424242";');
    expect(page).toMatch(/digitsOf\(card\.number\) !== TEST_CARD\) said\["card\.number"\] = ONLY_TEST_CARD/);
    // Whatever departs from the test number, at its first digit and at any length, empties the field.
    expect(page).toMatch(/if \(!TEST_CARD\.startsWith\(typed\)\) \{\s*setCard\(\{ \.\.\.next, number: "", cvc: "" \}\);/);
    // And the card is emptied once the booking is made.
    expect(page).toMatch(/setCard\(EMPTY_CARD\);\s*setDone\(res\);/);
  });
});
