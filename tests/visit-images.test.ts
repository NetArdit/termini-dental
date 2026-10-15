import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportBackup, restoreBackup } from "../src/server/backup";
import { client, newClinic, newDentist, startApp, type TestApp } from "./helpers";

// Pictures of a visit: X-rays and photographs beside the report. They are clinical records: who may add,
// see and remove one follows the report's own rules, and nobody who is not signed in is ever served one.
// Every picture here is synthetic, drawn by this file.

const NOW = "2026-10-12T08:00:00Z";
const AFTER = "2026-10-12T12:40:00Z";

/** A real, small PNG: a square of one grey. */
function png(grey: number, size = 8): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let c = 0xffffffff;
    for (const b of body) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 0, 0, 0, 0], 8);
  const raw = Buffer.alloc((size + 1) * size, grey);
  for (let y = 0; y < size; y++) raw[y * (size + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const picture = (grey = 128, extra: Record<string, unknown> = {}) => ({ kind: "xray", caption: null, contentType: "image/png", data: png(grey).toString("base64"), ...extra });

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
beforeEach(() => app.setNow(NOW));

type Clinic = Awaited<ReturnType<typeof newClinic>>;
async function visit(c: Clinic, opts: { startsAt?: string; dentistId?: number; patientId?: number } = {}) {
  app.setNow("2026-10-12T06:00:00Z");
  const made = await c.admin.post("/api/appointments", {
    dentistId: opts.dentistId ?? c.adminId,
    serviceId: c.checkup.id,
    startsAt: opts.startsAt ?? "2026-10-12T07:00:00.000Z",
    ...(opts.patientId ? { patientId: opts.patientId } : { newPatient: { fullName: "Pacient Provë", phone: "044 111 222" } }),
  });
  expect(made.status).toBe(201);
  app.setNow(AFTER);
  return made.data.id as number;
}

describe("adding and seeing the pictures of a visit", () => {
  it("a picture is stored with the visit, listed, and served back byte for byte to whoever may see the visit", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    const sent = png(90);
    const added = await c.admin.post(`/api/appointments/${id}/images`, { kind: "xray", caption: "Dhëmbi 36", contentType: "image/png", data: sent.toString("base64") });
    expect(added.status).toBe(201);

    const list = (await c.admin.get(`/api/appointments/${id}/images`)).data;
    expect(list.images).toHaveLength(1);
    expect(list.images[0]).toMatchObject({ id: added.data.id, kind: "xray", caption: "Dhëmbi 36", uploadedBy: "Dr. Arta Krasniqi", url: `/api/images/${added.data.id}` });
    expect(list.earlier).toEqual([]);

    const got = await c.admin.raw(`/api/images/${added.data.id}`);
    expect(got.status).toBe(200);
    expect(got.type).toBe("image/png");
    expect(got.cache).toBe("private, no-store");
    expect(got.sniff).toBe("nosniff");
    expect(got.bytes.equals(sent)).toBe(true);
    expect((await app.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'visit_image_added' AND entity_id = $1", [id])).length).toBe(1);
  });

  it("nobody who is not signed in gets a picture or the list, and a made-up id is not found", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    const imageId = (await c.admin.post(`/api/appointments/${id}/images`, picture())).data.id;
    const nobody = client(app.base);
    expect((await nobody.raw(`/api/images/${imageId}`)).status).toBe(401);
    expect((await nobody.get(`/api/appointments/${id}/images`)).status).toBe(401);
    expect((await nobody.post(`/api/appointments/${id}/images`, picture())).status).toBe(401);
    expect((await c.admin.raw("/api/images/99999999")).status).toBe(404);
  });

  it("a colleague who may not open the visit can neither see, add nor remove its pictures", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const id = await visit(c);
    const imageId = (await c.admin.post(`/api/appointments/${id}/images`, picture())).data.id;
    expect((await besnik.client.get(`/api/appointments/${id}/images`)).status).toBe(404);
    expect((await besnik.client.raw(`/api/images/${imageId}`)).status).toBe(404);
    expect((await besnik.client.post(`/api/appointments/${id}/images`, picture())).status).toBe(404);
    expect((await besnik.client.del(`/api/images/${imageId}`)).status).toBe(404);
    expect((await c.admin.raw(`/api/images/${imageId}`)).status).toBe(200);
  });

  it("the X-ray of an earlier visit appears at the patient's later visit, for the dentist responsible for the patient", async () => {
    const c = await newClinic(app);
    const first = await visit(c, { startsAt: "2026-10-12T07:00:00.000Z" });
    const patientId = (await app.ctx.db.query<{ patient_id: number }>("SELECT patient_id FROM appointments WHERE id = $1", [first]))[0]!.patient_id;
    const old = (await c.admin.post(`/api/appointments/${first}/images`, picture(60))).data.id;
    const second = await visit(c, { startsAt: "2026-10-12T09:00:00.000Z", patientId });
    const fresh = (await c.admin.post(`/api/appointments/${second}/images`, picture(200))).data.id;

    const atSecond = (await c.admin.get(`/api/appointments/${second}/images`)).data;
    expect(atSecond.images.map((i: { id: number }) => i.id)).toEqual([fresh]);
    expect(atSecond.earlier.map((i: { id: number }) => i.id)).toEqual([old]);
    // At the first visit, the later one's picture is not "earlier".
    expect((await c.admin.get(`/api/appointments/${first}/images`)).data.earlier).toEqual([]);

    // The patient's page shows each visit's pictures.
    const page = (await c.admin.get(`/api/patients/${patientId}`)).data;
    const byVisit = Object.fromEntries(page.visits.map((v: { id: number; images: Array<{ id: number }> }) => [v.id, v.images.map((i) => i.id)]));
    expect(byVisit).toEqual({ [first]: [old], [second]: [fresh] });
  });

  it("a dentist who treats a colleague's patient once sees that visit's pictures, not the patient's whole history", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const first = await visit(c);
    const patientId = (await app.ctx.db.query<{ patient_id: number }>("SELECT patient_id FROM appointments WHERE id = $1", [first]))[0]!.patient_id;
    const old = (await c.admin.post(`/api/appointments/${first}/images`, picture(60))).data.id;
    // The same patient, a later visit with the other dentist.
    const second = await visit(c, { startsAt: "2026-10-12T09:00:00.000Z", patientId, dentistId: besnik.id });
    const his = await besnik.client.post(`/api/appointments/${second}/images`, picture(200));
    expect(his.status).toBe(201);
    const seen = (await besnik.client.get(`/api/appointments/${second}/images`)).data;
    expect(seen.images.map((i: { id: number }) => i.id)).toEqual([his.data.id]);
    expect(seen.earlier).toEqual([]);
    expect((await besnik.client.raw(`/api/images/${old}`)).status).toBe(404);
    // The responsible dentist (the administrator here) sees both.
    expect((await c.admin.get(`/api/appointments/${second}/images`)).data.earlier.map((i: { id: number }) => i.id)).toEqual([old]);
  });
});

describe("what is refused", () => {
  it("not before the day of the visit, and never for a cancelled appointment", async () => {
    const c = await newClinic(app);
    app.setNow(NOW);
    const future = (await c.admin.post("/api/appointments", { dentistId: c.adminId, serviceId: c.checkup.id, startsAt: "2026-10-14T07:00:00.000Z", newPatient: { fullName: "Pacient i Ardhshëm" } })).data.id as number;
    expect((await c.admin.post(`/api/appointments/${future}/images`, picture())).status).toBe(409);
    await c.admin.post(`/api/appointments/${future}/cancel`, { reason: "Ndryshim" });
    expect((await c.admin.post(`/api/appointments/${future}/images`, picture())).status).toBe(409);
    expect((await app.ctx.db.query("SELECT 1 FROM visit_images")).length).toBe(0);
  });

  it("a file that is not the picture it claims to be, an unknown kind, extra fields, and anything too large", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    const text = Buffer.from("<script>alert(1)</script> this is not a picture at all").toString("base64");
    const wrong: Array<Record<string, unknown>> = [
      picture(1, { data: text }),
      picture(1, { contentType: "image/jpeg" }), // a PNG that says it is a JPEG
      picture(1, { contentType: "image/svg+xml" }),
      picture(1, { contentType: "text/html" }),
      picture(1, { kind: "document" }),
      picture(1, { data: "not base64 !!" }),
      picture(1, { patientId: 1 }),
      { kind: "xray" },
    ];
    for (const body of wrong) expect((await c.admin.post(`/api/appointments/${id}/images`, body)).status, JSON.stringify(body).slice(0, 70)).toBe(400);
    // A real picture with something glued on behind it, one cut short, and one whose checksum is wrong:
    // the first bytes are right in all three, the file as a whole is not a picture.
    const good = png(1);
    const broken = Buffer.from(good);
    broken[broken.length - 20] = broken[broken.length - 20]! ^ 0xff;
    for (const bytes of [Buffer.concat([good, Buffer.from("<script>alert(1)</script>")]), good.subarray(0, good.length - 5), broken]) {
      expect((await c.admin.post(`/api/appointments/${id}/images`, picture(1, { data: bytes.toString("base64") }))).status).toBe(400);
    }
    // Larger than a picture may be: refused before it is stored.
    const big = Buffer.concat([png(1), Buffer.alloc(1_200_000, 7)]).toString("base64");
    expect([400, 413]).toContain((await c.admin.post(`/api/appointments/${id}/images`, picture(1, { data: big }))).status);
    expect((await app.ctx.db.query("SELECT 1 FROM visit_images")).length).toBe(0);
    // And the general limit on requests still holds everywhere else.
    expect((await c.admin.post("/api/patients", { fullName: "x".repeat(200_000) })).status).toBe(413);
  });

  it("the whole clinic has a ceiling too: when it is reached nothing more is taken until something is removed", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    const one = png(5).length;
    process.env.TEST_MAX_CLINIC_IMAGE_BYTES = String(one * 2 + 1);
    try {
      const first = await c.admin.post(`/api/appointments/${id}/images`, picture(5));
      expect(first.status).toBe(201);
      expect((await c.admin.post(`/api/appointments/${id}/images`, picture(5))).status).toBe(201);
      const full = await c.admin.post(`/api/appointments/${id}/images`, picture(5));
      expect(full.status).toBe(409);
      expect(full.data.error).toMatch(/Hapësira/);
      expect((await c.admin.del(`/api/images/${first.data.id}`)).status).toBe(200);
      expect((await c.admin.post(`/api/appointments/${id}/images`, picture(5))).status).toBe(201);
    } finally {
      delete process.env.TEST_MAX_CLINIC_IMAGE_BYTES;
    }
  });

  it("the clinic's ceiling holds when pictures for two different visits arrive at the same instant", async () => {
    const c = await newClinic(app);
    const first = await visit(c);
    const second = await visit(c, { startsAt: "2026-10-12T09:00:00.000Z" });
    // Room for one more picture, not for two.
    process.env.TEST_MAX_CLINIC_IMAGE_BYTES = String(png(5).length + 1);
    try {
      const both = await Promise.all([c.admin.post(`/api/appointments/${first}/images`, picture(5)), c.admin.post(`/api/appointments/${second}/images`, picture(5))]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect((await app.ctx.db.query("SELECT 1 FROM visit_images")).length).toBe(1);
    } finally {
      delete process.env.TEST_MAX_CLINIC_IMAGE_BYTES;
    }
  });

  it("more than six pictures for one visit, also when two arrive at once", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    for (let i = 0; i < 5; i++) expect((await c.admin.post(`/api/appointments/${id}/images`, picture(i))).status).toBe(201);
    const both = await Promise.all([c.admin.post(`/api/appointments/${id}/images`, picture(100)), c.admin.post(`/api/appointments/${id}/images`, picture(101))]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await c.admin.get(`/api/appointments/${id}/images`)).data.images).toHaveLength(6);
  });
});

describe("removing, and what happens to pictures with the rest of the record", () => {
  it("whoever added it or the administrator removes it; a colleague who can see it cannot", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const id = await visit(c, { dentistId: besnik.id });
    const his = (await besnik.client.post(`/api/appointments/${id}/images`, picture(10))).data.id;
    const hers = (await c.admin.post(`/api/appointments/${id}/images`, picture(20))).data.id;
    expect((await besnik.client.del(`/api/images/${hers}`)).status).toBe(403);
    expect((await besnik.client.del(`/api/images/${his}`)).status).toBe(200);
    expect((await c.admin.del(`/api/images/${hers}`)).status).toBe(200);
    expect((await c.admin.raw(`/api/images/${his}`)).status).toBe(404);
    expect((await app.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'visit_image_removed'")).length).toBe(2);
  });

  it("a backup carries the pictures and gives them back the same", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    const sent = png(77, 16);
    const imageId = (await c.admin.post(`/api/appointments/${id}/images`, { kind: "photo", caption: null, contentType: "image/png", data: sent.toString("base64") })).data.id;
    const backup = JSON.parse(JSON.stringify(await exportBackup(app.ctx.db, app.ctx.now())));
    expect(backup.tables.visit_images).toHaveLength(1);
    const second = await startApp(AFTER);
    try {
      await restoreBackup(second.ctx.db, backup);
      const row = (await second.ctx.db.query<{ data_base64: string; kind: string }>("SELECT data_base64, kind FROM visit_images WHERE id = $1", [imageId]))[0]!;
      expect(Buffer.from(row.data_base64, "base64").equals(sent)).toBe(true);
      expect(row.kind).toBe("photo");
    } finally {
      await second.close();
    }
  });

  it("go with their appointment when it is removed", async () => {
    const c = await newClinic(app);
    const id = await visit(c);
    await c.admin.post(`/api/appointments/${id}/images`, picture());
    await app.ctx.db.query("DELETE FROM appointments WHERE id = $1", [id]);
    expect((await app.ctx.db.query("SELECT 1 FROM visit_images")).length).toBe(0);
  });
});
