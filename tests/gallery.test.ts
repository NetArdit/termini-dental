import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, newClinic, newDentist, startApp, type TestApp } from "./helpers";

// "Punët tona": the public sees only what the administrator published; a patient's picture is stored only
// with its consent on record, and is gone from the public pages the moment the consent is taken back.

const NOW = "2026-10-12T08:00:00Z";

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
const pic = (grey: number) => ({ contentType: "image/png", data: png(grey).toString("base64") });
const illustrative = (extra: Record<string, unknown> = {}) => ({ title: "Kabina", description: "Pajisje moderne.", after: pic(10), basis: "illustrative", ...extra });
const patient = (extra: Record<string, unknown> = {}) => ({ title: "Zbardhim", after: pic(20), before: pic(21), basis: "patient", consentGivenOn: "2026-10-01", consentReference: "Dosja e pëlqimeve, nr. 14", ...extra });

let app: TestApp;
beforeAll(async () => {
  app = await startApp(NOW);
});
afterAll(() => app.close());
const pub = () => client(app.base);
const publicItems = async () => (await pub().get("/api/public/gallery")).data.items as Array<Record<string, unknown>>;

describe("what the public sees", () => {
  it("nothing until an item is published; then its title and pictures, an illustrative one marked so, and nothing about consent", async () => {
    const c = await newClinic(app);
    expect(await publicItems()).toEqual([]);
    const a = (await c.admin.post("/api/gallery", illustrative())).data.id;
    const b = (await c.admin.post("/api/gallery", patient())).data.id;
    expect(await publicItems()).toEqual([]);
    expect((await pub().raw(`/api/public/gallery/${a}/after`)).status).toBe(404);

    for (const id of [a, b]) expect((await c.admin.patch(`/api/gallery/${id}`, { status: "published" })).status).toBe(200);
    const items = await publicItems();
    expect(items).toEqual([
      { id: b, title: "Zbardhim", description: null, illustrative: false, after: `/api/public/gallery/${b}/after`, before: `/api/public/gallery/${b}/before` },
      { id: a, title: "Kabina", description: "Pajisje moderne.", illustrative: true, after: `/api/public/gallery/${a}/after`, before: null },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/Dosja|consent|pëlqim|2026-10-01|Arta/);

    const got = await pub().raw(`/api/public/gallery/${b}/before`);
    expect([got.status, got.type, got.sniff]).toEqual([200, "image/png", "nosniff"]);
    expect(got.cache).toMatch(/no-store/);
    expect(got.bytes.equals(png(21))).toBe(true);
    expect((await pub().raw(`/api/public/gallery/${a}/before`)).status).toBe(404);
    expect((await pub().raw(`/api/public/gallery/${a}/elsewhere`)).status).toBe(404);
  });
});

describe("a patient's picture and its consent", () => {
  it("is not stored at all without the day of the consent and where the signed form is kept", async () => {
    const c = await newClinic(app);
    for (const bad of [patient({ consentGivenOn: null }), patient({ consentReference: null }), patient({ consentReference: "   " }), patient({ consentGivenOn: "2026-13-40" }), patient({ consentGivenOn: "2026-10-13" })]) {
      expect((await c.admin.post("/api/gallery", bad)).status, JSON.stringify(bad).slice(-80)).toBe(400);
    }
    expect((await app.ctx.db.query("SELECT 1 FROM gallery_items")).length).toBe(0);
    // The database holds the same rule, whoever writes the row.
    await expect(app.ctx.db.query("INSERT INTO gallery_items (clinic_id, title, after_type, after_base64, basis, created_by) VALUES ($1, 'x', 'image/png', 'AAAA', 'patient', $2)", [c.clinic.id, c.adminId])).rejects.toThrow();

    const made = await c.admin.post("/api/gallery", patient());
    expect(made.status).toBe(201);
    const mine = (await c.admin.get("/api/gallery")).data.items[0];
    expect(mine.status).toBe("draft");
    expect(mine.consent).toMatchObject({ givenOn: "2026-10-01", reference: "Dosja e pëlqimeve, nr. 14", recordedBy: "Dr. Arta Krasniqi", revokedAt: null });
  });

  it("taken back: off the public pages at once, pictures included, and never publishable again", async () => {
    const c = await newClinic(app);
    const id = (await c.admin.post("/api/gallery", patient())).data.id;
    await c.admin.patch(`/api/gallery/${id}`, { status: "published" });
    expect(await publicItems()).toHaveLength(1);
    expect((await pub().raw(`/api/public/gallery/${id}/after`)).status).toBe(200);

    expect((await c.admin.post(`/api/gallery/${id}/revoke`)).status).toBe(200);
    expect(await publicItems()).toEqual([]);
    expect((await pub().raw(`/api/public/gallery/${id}/after`)).status).toBe(404);
    expect((await pub().raw(`/api/public/gallery/${id}/before`)).status).toBe(404);
    expect((await c.admin.patch(`/api/gallery/${id}`, { status: "published" })).status).toBe(409);
    expect((await c.admin.post(`/api/gallery/${id}/revoke`)).status).toBe(404);
    await expect(app.ctx.db.query("UPDATE gallery_items SET status = 'published' WHERE id = $1", [id])).rejects.toThrow();
    expect((await c.admin.get("/api/gallery")).data.items[0].consent.revokedAt).toBeTruthy();
    expect((await app.ctx.db.query("SELECT 1 FROM audit_log WHERE action IN ('gallery_item_added', 'gallery_item_published', 'gallery_consent_revoked')")).length).toBe(3);

    // An illustrative item has no consent to take back.
    const other = (await c.admin.post("/api/gallery", illustrative())).data.id;
    expect((await c.admin.post(`/api/gallery/${other}/revoke`)).status).toBe(404);
    // Removed for good, pictures and all.
    expect((await c.admin.del(`/api/gallery/${id}`)).status).toBe(200);
    expect((await c.admin.raw(`/api/gallery/${id}/after`)).status).toBe(404);
  });
});

describe("who may touch the gallery, and what it takes", () => {
  it("only the administrator adds, publishes, revokes, removes or sees a draft", async () => {
    const c = await newClinic(app);
    const besnik = await newDentist(app, c.admin);
    const id = (await c.admin.post("/api/gallery", illustrative())).data.id;
    for (const who of [besnik.client, pub()]) {
      const expected = who === besnik.client ? 403 : 401;
      expect((await who.get("/api/gallery")).status).toBe(expected);
      expect((await who.post("/api/gallery", illustrative())).status).toBe(expected);
      expect((await who.patch(`/api/gallery/${id}`, { status: "published" })).status).toBe(expected);
      expect((await who.post(`/api/gallery/${id}/revoke`)).status).toBe(expected);
      expect((await who.del(`/api/gallery/${id}`)).status).toBe(expected);
      expect((await who.raw(`/api/gallery/${id}/after`)).status).toBe(expected);
    }
    expect(await publicItems()).toEqual([]);
    expect((await c.admin.raw(`/api/gallery/${id}/after`)).bytes.equals(png(10))).toBe(true);
  });

  it("only real pictures, a title, a known basis, and no more than the gallery holds", async () => {
    const c = await newClinic(app);
    const notPicture = { contentType: "image/png", data: Buffer.from("<script>alert(1)</script> not a picture").toString("base64") };
    const withTail = { contentType: "image/png", data: Buffer.concat([png(1), Buffer.from("tail")]).toString("base64") };
    for (const bad of [illustrative({ title: "  " }), illustrative({ after: notPicture }), illustrative({ before: withTail }), illustrative({ after: { contentType: "image/svg+xml", data: "AAAAAAAAAAAAAAAAAAAA" } }), illustrative({ basis: "ours" }), illustrative({ status: "published" }), { title: "Pa fotografi", basis: "illustrative" }]) {
      expect((await c.admin.post("/api/gallery", bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await c.admin.patch("/api/gallery/999999", { status: "published" })).status).toBe(404);
    expect((await c.admin.patch("/api/gallery/1", { status: "hidden" })).status).toBe(400);
    for (let i = 0; i < 24; i++) expect((await c.admin.post("/api/gallery", illustrative({ title: `Puna ${i}` }))).status).toBe(201);
    expect((await c.admin.post("/api/gallery", illustrative())).status).toBe(409);
  });
});
