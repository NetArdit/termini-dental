import { Router } from "express";
import { z } from "zod";
import { hashPassword, requireAdmin, requireUser, type SessionUser } from "../auth";
import { audit, clinicById, mapClinic, type Ctx } from "../context";
import { LAST_ADMINISTRATOR, UNIQUE_VIOLATION, pgErrorCode, type Queryer } from "../db";
import { HttpError, idParam, parse } from "../errors";
import { lockDentist } from "../booking";
import { insertDefaultHours } from "./auth";

const clinicPatch = z
  .object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().max(40).nullable(),
    address: z.string().trim().max(200).nullable(),
    bookingNoticeHours: z.number().int().min(0).max(720),
    cancelNoticeHours: z.number().int().min(0).max(720),
    slotStepMinutes: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
    bookingHorizonDays: z.number().int().min(1).max(365),
  })
  .partial();

const staffCreate = z.object({
  fullName: z.string().trim().min(2, "Emri është i detyrueshëm.").max(120),
  email: z.string().trim().toLowerCase().email("Email i pavlefshëm.").max(200),
  password: z.string().min(8, "Fjalëkalimi duhet të ketë të paktën 8 shkronja.").max(200),
  role: z.enum(["admin", "dentist"]).default("dentist"),
  isBookable: z.boolean().default(true),
});

const staffPatch = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    role: z.enum(["admin", "dentist"]),
    isBookable: z.boolean(),
    isActive: z.boolean(),
    password: z.string().min(8, "Fjalëkalimi duhet të ketë të paktën 8 shkronja.").max(200),
  })
  .partial();

const hoursSchema = z.object({
  hours: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
      }),
    )
    .max(28),
});

const timeOffSchema = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  reason: z.string().trim().max(200).optional(),
});

const serviceCreate = z.object({
  name: z.string().trim().min(2, "Emri është i detyrueshëm.").max(80),
  durationMinutes: z.number().int().min(5, "Të paktën 5 minuta.").max(480),
});
const servicePatch = z
  .object({ name: z.string().trim().min(2).max(80), durationMinutes: z.number().int().min(5).max(480), isActive: z.boolean() })
  .partial();

interface StaffRow {
  id: number;
  role: "admin" | "dentist";
  full_name: string;
  email: string;
  is_bookable: boolean;
  is_active: boolean;
}

const mapStaff = (u: StaffRow) => ({ id: u.id, role: u.role, fullName: u.full_name, email: u.email, isBookable: u.is_bookable, isActive: u.is_active });

/** The staff member `id`, but only inside the requester's own clinic. */
async function staffInClinic(q: Queryer, clinicId: number, id: number): Promise<StaffRow> {
  const rows = await q.query<StaffRow>("SELECT id, role, full_name, email, is_bookable, is_active FROM users WHERE id = $1 AND clinic_id = $2", [id, clinicId]);
  if (!rows[0]) throw new HttpError(404, "Përdoruesi nuk u gjet.");
  return rows[0];
}

/** A dentist manages their own schedule; an administrator manages everyone's. */
function assertSelfOrAdmin(user: SessionUser, staffId: number) {
  if (user.role !== "admin" && user.id !== staffId) throw new HttpError(403, "Mund të ndryshoni vetëm orarin tuaj.");
}

export function clinicRoutes(ctx: Ctx): Router {
  const r = Router();

  // ---- clinic settings ------------------------------------------------------------------------------
  r.get("/clinic", async (req, res) => {
    const user = requireUser(req);
    res.json({ clinic: mapClinic(await clinicById(ctx.db, user.clinicId)) });
  });

  r.patch("/clinic", async (req, res) => {
    const user = requireAdmin(req);
    const input = parse(clinicPatch, req.body);
    const columns: Record<string, string> = {
      name: "name",
      phone: "phone",
      address: "address",
      bookingNoticeHours: "booking_notice_hours",
      cancelNoticeHours: "cancel_notice_hours",
      slotStepMinutes: "slot_step_minutes",
      bookingHorizonDays: "booking_horizon_days",
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      params.push(value === "" ? null : value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length) {
      params.push(user.clinicId);
      await ctx.db.query(`UPDATE clinics SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
      await audit(ctx.db, { clinicId: user.clinicId, userId: user.id, action: "clinic_updated", entity: "clinic", entityId: user.clinicId, meta: input });
    }
    res.json({ clinic: mapClinic(await clinicById(ctx.db, user.clinicId)) });
  });

  // ---- staff ----------------------------------------------------------------------------------------
  r.get("/staff", async (req, res) => {
    const user = requireUser(req);
    const rows = await ctx.db.query<StaffRow>(
      "SELECT id, role, full_name, email, is_bookable, is_active FROM users WHERE clinic_id = $1 ORDER BY is_active DESC, full_name",
      [user.clinicId],
    );
    res.json({ staff: rows.map(mapStaff) });
  });

  r.post("/staff", async (req, res) => {
    const user = requireAdmin(req);
    const input = parse(staffCreate, req.body);
    const passwordHash = await hashPassword(input.password);
    try {
      const id = await ctx.db.tx(async (q) => {
        const rows = await q.query<{ id: number }>(
          "INSERT INTO users (clinic_id, role, full_name, email, password_hash, is_bookable) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
          [user.clinicId, input.role, input.fullName, input.email, passwordHash, input.isBookable],
        );
        const newId = rows[0]!.id;
        if (input.isBookable) await insertDefaultHours(q, newId);
        await audit(q, { clinicId: user.clinicId, userId: user.id, action: "staff_created", entity: "user", entityId: newId, meta: { role: input.role } });
        return newId;
      });
      res.status(201).json({ staff: mapStaff(await staffInClinic(ctx.db, user.clinicId, id)) });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) throw new HttpError(409, "Ky email është i regjistruar tashmë.", { email: "I zënë" });
      throw err;
    }
  });

  r.patch("/staff/:id", async (req, res) => {
    const user = requireAdmin(req);
    const id = idParam(req.params.id);
    const input = parse(staffPatch, req.body);
    const lastAdministrator = () => new HttpError(409, "Klinika duhet të ketë të paktën një administrator aktiv.");
    await ctx.db
      .tx(async (q) => {
      // Changes to a clinic's staff happen one at a time: the second of two requests waits here and then
      // sees what the first one did. (The database enforces the rule by itself as well; see migrations/001_baseline.sql.)
      await q.query("SELECT 1 FROM clinics WHERE id = $1 FOR NO KEY UPDATE", [user.clinicId]);
      const target = await staffInClinic(q, user.clinicId, id);
      const losesAdmin = target.role === "admin" && target.is_active && (input.role === "dentist" || input.isActive === false);
      if (losesAdmin) {
        // A clinic must always keep one working administrator, or nobody could manage it again.
        const others = await q.query("SELECT 1 FROM users WHERE clinic_id = $1 AND role = 'admin' AND is_active AND id <> $2 LIMIT 1", [user.clinicId, id]);
        if (!others.length) throw lastAdministrator();
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (input.fullName !== undefined) set("full_name", input.fullName);
      if (input.role !== undefined) set("role", input.role);
      if (input.isBookable !== undefined) set("is_bookable", input.isBookable);
      if (input.isActive !== undefined) set("is_active", input.isActive);
      if (input.password !== undefined) set("password_hash", await hashPassword(input.password));
      if (!sets.length) return;
      params.push(id);
      await q.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
      // A deactivated account or a changed password ends every open session of that person.
      if (input.isActive === false || input.password !== undefined) await q.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      await audit(q, {
        clinicId: user.clinicId,
        userId: user.id,
        action: "staff_updated",
        entity: "user",
        entityId: id,
        meta: { ...input, password: input.password === undefined ? undefined : "changed" },
      });
      })
      .catch((err: unknown) => {
        // The database refused at commit: the same answer as when the check above catches it.
        if (pgErrorCode(err) === LAST_ADMINISTRATOR) throw lastAdministrator();
        throw err;
      });
    res.json({ staff: mapStaff(await staffInClinic(ctx.db, user.clinicId, id)) });
  });

  // ---- working hours --------------------------------------------------------------------------------
  r.get("/staff/:id/hours", async (req, res) => {
    const user = requireUser(req);
    const id = idParam(req.params.id);
    await staffInClinic(ctx.db, user.clinicId, id);
    const rows = await ctx.db.query<{ weekday: number; start_minute: number; end_minute: number }>(
      "SELECT weekday, start_minute, end_minute FROM working_hours WHERE user_id = $1 ORDER BY weekday, start_minute",
      [id],
    );
    res.json({ hours: rows.map((h) => ({ weekday: h.weekday, startMinute: h.start_minute, endMinute: h.end_minute })) });
  });

  // Replaces the whole weekly schedule of one person.
  r.put("/staff/:id/hours", async (req, res) => {
    const user = requireUser(req);
    const id = idParam(req.params.id);
    assertSelfOrAdmin(user, id);
    const { hours } = parse(hoursSchema, req.body);
    for (const h of hours) {
      if (h.endMinute <= h.startMinute) throw new HttpError(400, "Ora e mbarimit duhet të jetë pas orës së fillimit.");
    }
    for (const a of hours) {
      for (const b of hours) {
        if (a !== b && a.weekday === b.weekday && a.startMinute < b.endMinute && b.startMinute < a.endMinute) {
          throw new HttpError(400, "Dy periudha pune të së njëjtës ditë mbivendosen.");
        }
      }
    }
    await ctx.db.tx(async (q) => {
      await staffInClinic(q, user.clinicId, id);
      await q.query("DELETE FROM working_hours WHERE user_id = $1", [id]);
      for (const h of hours) {
        await q.query("INSERT INTO working_hours (user_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4)", [id, h.weekday, h.startMinute, h.endMinute]);
      }
    });
    res.json({ ok: true });
  });

  // ---- time off -------------------------------------------------------------------------------------
  r.get("/staff/:id/time-off", async (req, res) => {
    const user = requireUser(req);
    const id = idParam(req.params.id);
    await staffInClinic(ctx.db, user.clinicId, id);
    const rows = await ctx.db.query<{ id: number; starts_at: Date; ends_at: Date; reason: string | null }>(
      "SELECT id, starts_at, ends_at, reason FROM time_off WHERE user_id = $1 AND ends_at > $2 ORDER BY starts_at",
      [id, ctx.now()],
    );
    res.json({ timeOff: rows.map((t) => ({ id: t.id, startsAt: t.starts_at, endsAt: t.ends_at, reason: t.reason })) });
  });

  r.post("/staff/:id/time-off", async (req, res) => {
    const user = requireUser(req);
    const id = idParam(req.params.id);
    assertSelfOrAdmin(user, id);
    const input = parse(timeOffSchema, req.body);
    if (input.endsAt <= input.startsAt) throw new HttpError(400, "Mbarimi duhet të jetë pas fillimit.");
    await staffInClinic(ctx.db, user.clinicId, id);
    const newId = await ctx.db.tx(async (q) => {
      // Under the dentist's lock, so a booking cannot slip in between the check and the insert.
      await lockDentist(q, id);
      // Time off never cancels anything by itself: the clinic must first deal with the patients already booked.
      const booked = await q.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM appointments WHERE dentist_id = $1 AND status = 'booked' AND starts_at < $3 AND ends_at > $2",
        [id, input.startsAt, input.endsAt],
      );
      if (booked[0]!.n > 0) {
        throw new HttpError(409, `Në këtë periudhë ka ${booked[0]!.n} termine të caktuara. Anulojini ose zhvendosini ato së pari.`);
      }
      const rows = await q.query<{ id: number }>("INSERT INTO time_off (user_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4) RETURNING id", [
        id,
        input.startsAt,
        input.endsAt,
        input.reason || null,
      ]);
      return rows[0]!.id;
    });
    res.status(201).json({ id: newId });
  });

  r.delete("/time-off/:id", async (req, res) => {
    const user = requireUser(req);
    const id = idParam(req.params.id);
    const rows = await ctx.db.query<{ user_id: number }>(
      "SELECT t.user_id FROM time_off t JOIN users u ON u.id = t.user_id WHERE t.id = $1 AND u.clinic_id = $2",
      [id, user.clinicId],
    );
    if (!rows[0]) throw new HttpError(404, "Nuk u gjet.");
    assertSelfOrAdmin(user, rows[0].user_id);
    await ctx.db.query("DELETE FROM time_off WHERE id = $1", [id]);
    res.json({ ok: true });
  });

  // ---- services -------------------------------------------------------------------------------------
  r.get("/services", async (req, res) => {
    const user = requireUser(req);
    const rows = await ctx.db.query<{ id: number; name: string; duration_minutes: number; is_active: boolean }>(
      "SELECT id, name, duration_minutes, is_active FROM services WHERE clinic_id = $1 ORDER BY is_active DESC, name",
      [user.clinicId],
    );
    res.json({ services: rows.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes, isActive: s.is_active })) });
  });

  r.post("/services", async (req, res) => {
    const user = requireAdmin(req);
    const input = parse(serviceCreate, req.body);
    const rows = await ctx.db.query<{ id: number }>("INSERT INTO services (clinic_id, name, duration_minutes) VALUES ($1, $2, $3) RETURNING id", [
      user.clinicId,
      input.name,
      input.durationMinutes,
    ]);
    res.status(201).json({ id: rows[0]!.id });
  });

  r.patch("/services/:id", async (req, res) => {
    const user = requireAdmin(req);
    const id = idParam(req.params.id);
    const input = parse(servicePatch, req.body);
    const found = await ctx.db.query("SELECT 1 FROM services WHERE id = $1 AND clinic_id = $2", [id, user.clinicId]);
    if (!found.length) throw new HttpError(404, "Shërbimi nuk u gjet.");
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) sets.push(`name = $${params.push(input.name)}`);
    if (input.durationMinutes !== undefined) sets.push(`duration_minutes = $${params.push(input.durationMinutes)}`);
    if (input.isActive !== undefined) sets.push(`is_active = $${params.push(input.isActive)}`);
    if (sets.length) await ctx.db.query(`UPDATE services SET ${sets.join(", ")} WHERE id = $${params.push(id)}`, params);
    res.json({ ok: true });
  });

  return r;
}
