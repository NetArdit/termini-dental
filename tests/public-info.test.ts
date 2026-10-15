import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fmtMoney, fmtOpeningHours } from "../src/web/src/lib/format";
import { client, newClinic, newDentist, startApp, type TestApp } from "./helpers";

// What the public pages say about the clinic beyond booking: what a service starts from, and when the clinic
// is open. Both come from what the clinic itself entered; neither is ever made up by the page.

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

const pub = () => client(app.base);
const info = async () => (await pub().get("/api/public/clinic")).data;

describe("prices", () => {
  it("a clinic that was just set up publishes no price; the administrator sets one and patients see it", async () => {
    const { admin, checkup } = await newClinic(app);
    expect((await info()).services.every((s: { priceFromMinor: number | null }) => s.priceFromMinor === null)).toBe(true);

    expect((await admin.patch(`/api/services/${checkup.id}`, { priceFromMinor: 1000 })).status).toBe(200);
    const seen = (await info()).services.find((s: { id: number }) => s.id === checkup.id);
    expect(seen.priceFromMinor).toBe(1000);
    expect((await admin.get("/api/services")).data.services.find((s: { id: number }) => s.id === checkup.id).priceFromMinor).toBe(1000);

    // Taken off again: the page shows none, not zero.
    await admin.patch(`/api/services/${checkup.id}`, { priceFromMinor: null });
    expect((await info()).services.find((s: { id: number }) => s.id === checkup.id).priceFromMinor).toBeNull();
  });

  it("a new service can come with its price; a price that makes no sense is refused; only the administrator sets prices", async () => {
    const { admin, checkup } = await newClinic(app);
    const made = await admin.post("/api/services", { name: "Zbardhim dhëmbësh", durationMinutes: 60, priceFromMinor: 12000 });
    expect(made.status).toBe(201);
    expect((await info()).services.find((s: { id: number }) => s.id === made.data.id).priceFromMinor).toBe(12000);
    for (const bad of [-1, 10.5, 10_000_001, "20"]) expect((await admin.patch(`/api/services/${checkup.id}`, { priceFromMinor: bad })).status, String(bad)).toBe(400);
    const besnik = await newDentist(app, admin);
    expect((await besnik.client.patch(`/api/services/${checkup.id}`, { priceFromMinor: 500 })).status).toBe(403);
    expect((await pub().patch(`/api/services/${checkup.id}`, { priceFromMinor: 500 })).status).toBe(401);
    expect((await info()).services.find((s: { id: number }) => s.id === checkup.id).priceFromMinor).toBeNull();
    await expect(app.ctx.db.query("UPDATE services SET price_from_minor = -5 WHERE id = $1", [checkup.id])).rejects.toThrow();
  });

  it("a service that was switched off is not offered, with or without a price", async () => {
    const { admin, checkup } = await newClinic(app);
    await admin.patch(`/api/services/${checkup.id}`, { priceFromMinor: 1000, isActive: false });
    expect((await info()).services.some((s: { id: number }) => s.id === checkup.id)).toBe(false);
  });
});

describe("opening hours", () => {
  it("are the working hours of the dentists who take patients, put together day by day", async () => {
    const { admin, adminId } = await newClinic(app);
    // The administrator works Monday to Friday, 09:00 to 17:00 (the starting hours).
    expect((await info()).hours).toEqual([1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })));

    // A second dentist starts earlier on Monday and also works Saturday morning.
    const besnik = await newDentist(app, admin);
    const put = await admin.put(`/api/staff/${besnik.id}/hours`, {
      hours: [
        { weekday: 1, startMinute: 480, endMinute: 900 },
        { weekday: 6, startMinute: 540, endMinute: 780 },
      ],
    });
    expect(put.status).toBe(200);
    const hours = (await info()).hours as Array<{ weekday: number; startMinute: number; endMinute: number }>;
    expect(hours.find((h) => h.weekday === 1)).toEqual({ weekday: 1, startMinute: 480, endMinute: 1020 });
    expect(hours.find((h) => h.weekday === 6)).toEqual({ weekday: 6, startMinute: 540, endMinute: 780 });
    expect(hours.find((h) => h.weekday === 7)).toBeUndefined();

    // Somebody who no longer takes patients does not keep the clinic "open".
    await admin.patch(`/api/staff/${besnik.id}`, { isActive: false });
    expect(((await info()).hours as Array<{ weekday: number }>).some((h) => h.weekday === 6)).toBe(false);
    expect(adminId).toBeGreaterThan(0);
  });

  it("are written the way people say them", () => {
    const week = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
    expect(fmtOpeningHours(week)).toEqual([["E hënë – E premte", "09:00–17:00"]]);
    expect(fmtOpeningHours([...week, { weekday: 6, startMinute: 540, endMinute: 780 }])).toEqual([
      ["E hënë – E premte", "09:00–17:00"],
      ["E shtunë", "09:00–13:00"],
    ]);
    expect(fmtOpeningHours([{ weekday: 1, startMinute: 480, endMinute: 1020 }, ...week.slice(1)])).toEqual([
      ["E hënë", "08:00–17:00"],
      ["E martë – E premte", "09:00–17:00"],
    ]);
    expect(fmtOpeningHours([])).toEqual([]);
    expect([fmtMoney(1000, "EUR"), fmtMoney(1250, "EUR"), fmtMoney(12000, "EUR")]).toEqual(["10 €", "12,50 €", "120 €"]);
  });
});
