import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth";
import { audit, type Ctx } from "../context";
import { HttpError, idParam, parse } from "../errors";
import { isWholePicture, type PictureType } from "../imageCheck";
import { isIsoDate, localDate } from "../time";

// "Punët tona": the clinic's gallery. What may be shown and why is in migration 013. In short: a picture is
// either illustrative (and labelled so in public) or a patient's, and a patient's picture is stored only
// together with the record of the consent, published only while that consent stands, and gone from the
// public pages the moment it is taken back.
//
// The public answers never carry anything about consent or about who recorded it: a title, a description,
// the pictures, and whether the item is illustrative.

const MAX_IMAGE_BYTES = 1_048_576; // 1 MB each; the page makes a picture small before sending it
const MAX_ITEMS = 24;

const pictureSchema = z
  .object({
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    data: z.string().min(16).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Fotografia nuk u lexua dot."),
  })
  .strict();

const createSchema = z
  .object({
    title: z.string().trim().min(1, "Shkruani një titull.").max(120),
    description: z.string().trim().max(600).nullable().default(null),
    after: pictureSchema,
    before: pictureSchema.nullable().default(null),
    basis: z.enum(["illustrative", "patient"]),
    // Asked for only when the picture is a patient's.
    consentGivenOn: z.string().refine(isIsoDate, "Datë e pavlefshme.").nullable().default(null),
    consentReference: z.string().trim().max(200).nullable().default(null),
  })
  .strict();

function bytesOf(picture: { contentType: PictureType; data: string }, field: string): Buffer {
  const bytes = Buffer.from(picture.data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Fotografia është shumë e madhe. Më e shumta 1 MB.");
  if (!isWholePicture(bytes, picture.contentType)) throw new HttpError(400, "Ky skedar nuk është fotografi JPEG, PNG ose WebP.", { [field]: "Jo fotografi" });
  return bytes;
}

interface ItemRow {
  id: number;
  title: string;
  description: string | null;
  has_before: boolean;
  basis: "illustrative" | "patient";
  consent_given_on: string | Date | null;
  consent_reference: string | null;
  consent_recorded_name: string | null;
  consent_revoked_at: Date | null;
  status: "draft" | "published";
  created_at: Date;
}
const ITEM_SELECT = `SELECT g.id, g.title, g.description, (g.before_base64 IS NOT NULL) AS has_before, g.basis, g.consent_given_on::text AS consent_given_on, g.consent_reference,
                            u.full_name AS consent_recorded_name, g.consent_revoked_at, g.status, g.created_at
                       FROM gallery_items g LEFT JOIN users u ON u.id = g.consent_recorded_by`;

export function galleryRoutes(ctx: Ctx): Router {
  const r = Router();

  // ---- what everybody sees -----------------------------------------------------------------------------
  r.get("/public/gallery", async (_req, res) => {
    const rows = await ctx.db.query<ItemRow>(`${ITEM_SELECT} WHERE g.status = 'published' AND g.consent_revoked_at IS NULL ORDER BY g.id DESC`);
    res.json({
      items: rows.map((g) => ({
        id: g.id,
        title: g.title,
        description: g.description,
        illustrative: g.basis === "illustrative",
        after: `/api/public/gallery/${g.id}/after`,
        before: g.has_before ? `/api/public/gallery/${g.id}/before` : null,
      })),
    });
  });

  // A published picture. Asked for again every time (the API's answers are never stored by a browser or a
  // cache in between), so an item that was unpublished or whose consent was taken back is gone at once.
  r.get("/public/gallery/:id/:which", async (req, res) => {
    const which = req.params.which === "after" ? "after" : req.params.which === "before" ? "before" : null;
    if (!which) throw new HttpError(404, "Fotografia nuk u gjet.");
    const rows = await ctx.db.query<{ type: string | null; data: string | null }>(
      `SELECT ${which}_type AS type, ${which}_base64 AS data FROM gallery_items WHERE id = $1 AND status = 'published' AND consent_revoked_at IS NULL`,
      [idParam(req.params.id)],
    );
    if (!rows[0]?.type || !rows[0].data) throw new HttpError(404, "Fotografia nuk u gjet.");
    res.setHeader("Content-Type", rows[0].type);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.end(Buffer.from(rows[0].data, "base64"));
  });

  // ---- the administrator's side ------------------------------------------------------------------------
  const mapItem = (g: ItemRow) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    basis: g.basis,
    status: g.status,
    consent: g.basis === "patient" ? { givenOn: g.consent_given_on, reference: g.consent_reference, recordedBy: g.consent_recorded_name, revokedAt: g.consent_revoked_at } : null,
    after: `/api/gallery/${g.id}/after`,
    before: g.has_before ? `/api/gallery/${g.id}/before` : null,
    createdAt: g.created_at,
  });

  r.get("/gallery", async (req, res) => {
    const user = requireAdmin(req);
    const rows = await ctx.db.query<ItemRow>(`${ITEM_SELECT} WHERE g.clinic_id = $1 ORDER BY g.id DESC`, [user.clinicId]);
    res.json({ items: rows.map(mapItem), limit: MAX_ITEMS });
  });

  // The administrator sees every picture, published or not.
  r.get("/gallery/:id/:which", async (req, res) => {
    const user = requireAdmin(req);
    const which = req.params.which === "after" ? "after" : req.params.which === "before" ? "before" : null;
    if (!which) throw new HttpError(404, "Fotografia nuk u gjet.");
    const rows = await ctx.db.query<{ type: string | null; data: string | null }>(`SELECT ${which}_type AS type, ${which}_base64 AS data FROM gallery_items WHERE id = $1 AND clinic_id = $2`, [idParam(req.params.id), user.clinicId]);
    if (!rows[0]?.type || !rows[0].data) throw new HttpError(404, "Fotografia nuk u gjet.");
    res.setHeader("Content-Type", rows[0].type);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.end(Buffer.from(rows[0].data, "base64"));
  });

  // A new item is always a draft: showing it is a second, separate decision.
  r.post("/gallery", async (req, res) => {
    const user = requireAdmin(req);
    const input = parse(createSchema, req.body);
    const after = bytesOf(input.after, "after");
    const before = input.before ? bytesOf(input.before, "before") : null;
    const now = ctx.now();
    if (input.basis === "patient") {
      const fields: Record<string, string> = {};
      if (!input.consentGivenOn) fields.consentGivenOn = "E nevojshme";
      if (!input.consentReference) fields.consentReference = "E nevojshme";
      if (Object.keys(fields).length) throw new HttpError(400, "Për fotografinë e një pacienti shënoni kur e dha pëlqimin dhe ku ruhet formulari i nënshkruar.", fields);
      const clinic = (await ctx.db.query<{ timezone: string }>("SELECT timezone FROM clinics WHERE id = $1", [user.clinicId]))[0]!;
      if (input.consentGivenOn! > localDate(now, clinic.timezone)) throw new HttpError(400, "Data e pëlqimit nuk mund të jetë në të ardhmen.", { consentGivenOn: "Në të ardhmen" });
    }
    const patient = input.basis === "patient";
    const id = await ctx.db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtext('gallery_items'), $1)", [user.clinicId]);
      const have = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM gallery_items WHERE clinic_id = $1", [user.clinicId]))[0]!.n;
      if (have >= MAX_ITEMS) throw new HttpError(409, `Galeria mban më së shumti ${MAX_ITEMS} punë. Hiqni një që nuk duhet më.`);
      const made = await q.query<{ id: number }>(
        `INSERT INTO gallery_items (clinic_id, title, description, after_type, after_base64, before_type, before_base64, basis, consent_given_on, consent_reference, consent_recorded_by, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          user.clinicId,
          input.title,
          input.description || null,
          input.after.contentType,
          after.toString("base64"),
          before ? input.before!.contentType : null,
          before ? before.toString("base64") : null,
          input.basis,
          patient ? input.consentGivenOn : null,
          patient ? input.consentReference : null,
          patient ? user.id : null,
          user.id,
          now,
        ],
      );
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: "gallery_item_added", entity: "gallery_item", entityId: made[0]!.id, meta: { basis: input.basis } });
      return made[0]!.id;
    });
    res.status(201).json({ id });
  });

  // Shown or not shown. An item whose consent was taken back cannot be shown again: a new consent is a new item.
  r.patch("/gallery/:id", async (req, res) => {
    const user = requireAdmin(req);
    const { status } = parse(z.object({ status: z.enum(["published", "draft"]) }).strict(), req.body);
    const id = idParam(req.params.id);
    await ctx.db.tx(async (q) => {
      const rows = await q.query<{ consent_revoked_at: Date | null }>("SELECT consent_revoked_at FROM gallery_items WHERE id = $1 AND clinic_id = $2 FOR UPDATE", [id, user.clinicId]);
      if (!rows[0]) throw new HttpError(404, "Puna nuk u gjet.");
      if (status === "published" && rows[0].consent_revoked_at) throw new HttpError(409, "Pëlqimi për këtë fotografi është tërhequr. Nuk mund të shfaqet më.");
      await q.query("UPDATE gallery_items SET status = $2 WHERE id = $1", [id, status]);
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: status === "published" ? "gallery_item_published" : "gallery_item_unpublished", entity: "gallery_item", entityId: id });
    });
    res.json({ ok: true });
  });

  // The patient took the consent back: off the public pages in the same statement, and it stays on record
  // that there was a consent and when it ended. The pictures themselves are removed with DELETE.
  r.post("/gallery/:id/revoke", async (req, res) => {
    const user = requireAdmin(req);
    const id = idParam(req.params.id);
    await ctx.db.tx(async (q) => {
      const rows = await q.query<{ id: number }>(
        "UPDATE gallery_items SET status = 'draft', consent_revoked_at = $3 WHERE id = $1 AND clinic_id = $2 AND basis = 'patient' AND consent_revoked_at IS NULL RETURNING id",
        [id, user.clinicId, ctx.now()],
      );
      if (!rows[0]) throw new HttpError(404, "Nuk ka pëlqim në fuqi për këtë punë.");
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: "gallery_consent_revoked", entity: "gallery_item", entityId: id });
    });
    res.json({ ok: true });
  });

  r.delete("/gallery/:id", async (req, res) => {
    const user = requireAdmin(req);
    const id = idParam(req.params.id);
    await ctx.db.tx(async (q) => {
      const rows = await q.query<{ id: number }>("DELETE FROM gallery_items WHERE id = $1 AND clinic_id = $2 RETURNING id", [id, user.clinicId]);
      if (!rows[0]) throw new HttpError(404, "Puna nuk u gjet.");
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: "gallery_item_removed", entity: "gallery_item", entityId: id });
    });
    res.json({ ok: true });
  });

  return r;
}
