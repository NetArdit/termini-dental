import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, newClinic, newDentist, startApp, type TestApp } from "./helpers";

// What a patient sees of a dentist on the public page: a title and a portrait, set by the administrator or
// by the person themselves, and served only while the person is active and takes bookings.

function png(grey: number, size = 8): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let c = 0xffffffff;
    for (const b of body) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE((c ^ 0xffffffff) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 0, 0, 0, 0], 8);
  const raw = Buffer.alloc((size + 1) * size, grey);
  for (let y = 0; y < size; y++) raw[y * (size + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const picture = (grey: number) => ({ contentType: "image/png", data: png(grey).toString("base64") });

let app: TestApp;
beforeAll(async () => {
  app = await startApp("2026-10-12T08:00:00Z");
});
afterAll(() => app.close());

describe("a dentist's title", () => {
  it("is set by the administrator, shown on the public page, and cleared by an empty one", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const set = await c.admin.patch(`/api/staff/${besnik.id}`, { title: "  Specialist i Endodoncisë " });
    expect(set.status).toBe(200);
    expect(set.data.staff.title).toBe("Specialist i Endodoncisë");

    const info = (await client(app.base).get("/api/public/clinic")).data;
    const listed = info.dentists.find((d: { id: number }) => d.id === besnik.id);
    expect(listed.title).toBe("Specialist i Endodoncisë");
    expect(listed.hasPhoto).toBe(false);

    const cleared = await c.admin.patch(`/api/staff/${besnik.id}`, { title: "   " });
    expect(cleared.data.staff.title).toBeNull();
  });

  it("is refused when it is very long, and a dentist cannot change a title through the staff route", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    expect((await c.admin.patch(`/api/staff/${besnik.id}`, { title: "x".repeat(121) })).status).toBe(400);
    expect((await besnik.client.patch(`/api/staff/${besnik.id}`, { title: "Kirurg" })).status).toBe(403);
  });
});

describe("a dentist's portrait", () => {
  it("is stored after the whole file is checked, served publicly, and removed on request", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const put = await c.admin.put(`/api/staff/${besnik.id}/photo`, picture(40));
    expect(put.status).toBe(200);
    expect(put.data.staff.hasPhoto).toBe(true);

    const res = await fetch(`${app.base}/api/public/dentists/${besnik.id}/photo`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(png(40))).toBe(true);

    const listed = (await client(app.base).get("/api/public/clinic")).data.dentists.find((d: { id: number }) => d.id === besnik.id);
    expect(listed.hasPhoto).toBe(true);

    const removed = await c.admin.del(`/api/staff/${besnik.id}/photo`);
    expect(removed.status).toBe(200);
    expect((await fetch(`${app.base}/api/public/dentists/${besnik.id}/photo`)).status).toBe(404);
  });

  it("refuses what is not a whole picture, and what is too large", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const notAPicture = Buffer.from("not a picture at all, only text that claims to be one").toString("base64");
    expect((await c.admin.put(`/api/staff/${besnik.id}/photo`, { contentType: "image/png", data: notAPicture })).status).toBe(400);
    const truncated = png(7).subarray(0, 30).toString("base64");
    expect((await c.admin.put(`/api/staff/${besnik.id}/photo`, { contentType: "image/png", data: truncated })).status).toBe(400);
    const big = Buffer.alloc(450_000, 1).toString("base64");
    expect([400, 413]).toContain((await c.admin.put(`/api/staff/${besnik.id}/photo`, { contentType: "image/png", data: big })).status);
  });

  it("a dentist may set their own, not a colleague's; a deactivated person's is not served", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin, "Dr. Besnik Gashi");
    const linda = await newDentist(app, c.admin, "Dr. Linda Hoxha");
    expect((await besnik.client.put(`/api/staff/${besnik.id}/photo`, picture(60))).status).toBe(200);
    expect((await besnik.client.put(`/api/staff/${linda.id}/photo`, picture(61))).status).toBe(403);
    expect((await besnik.client.del(`/api/staff/${linda.id}/photo`)).status).toBe(403);

    expect((await fetch(`${app.base}/api/public/dentists/${besnik.id}/photo`)).status).toBe(200);
    await c.admin.patch(`/api/staff/${besnik.id}`, { isActive: false });
    expect((await fetch(`${app.base}/api/public/dentists/${besnik.id}/photo`)).status).toBe(404);
  });

  it("is not served for an address that is not a dentist of this clinic", async () => {
    await newClinic(app);
    expect((await fetch(`${app.base}/api/public/dentists/999999/photo`)).status).toBe(404);
    expect((await fetch(`${app.base}/api/public/dentists/abc/photo`)).status).toBe(404);
  });
});
