import { Router } from "express";
import { z } from "zod";
import { hashToken, newToken, requireUser, type SessionUser } from "../auth";
import { activeService, availability, bookableDentist, insertAppointment, normalizePhone } from "../booking";
import { audit, clinicById, type Ctx } from "../context";
import type { Queryer } from "../db";
import { HttpError, idParam, parse } from "../errors";
import { attemptDelivery, stillWorthSending } from "../mail";
import { notifyBooked, notifyCancelledByClinic } from "../notify";
import { HOUR_MS, addDays, dayBounds, isIsoDate, localDate } from "../time";

// The clinic's side: calendar, patients, visit reports. The access rule, applied everywhere below:
// - An administrator works with the whole clinic.
// - A patient's record and full history belong to the dentist currently responsible for them (patientScope).
// - An appointment belongs to the dentist who treats it, but for a patient who is not (or no longer) theirs
//   only while there is work to do on it (appointmentScope). Having once treated someone gives no lasting
//   access to that person's record.
// This split is a default the owner still has to confirm; see docs/STATE.md.

/** How long after its start a dentist can still open an appointment with a patient who is not theirs. */
const TREATING_ACCESS_DAYS = 7;
const treatingAccessSince = (now: Date) => new Date(now.getTime() - TREATING_ACCESS_DAYS * 24 * HOUR_MS);

const dateParam = z.string().refine(isIsoDate, "Datë e pavlefshme.");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const patientFields = {
  fullName: z.string().trim().min(3, "Shkruani emrin dhe mbiemrin.").max(120),
  phone: optionalText(30),
  email: z
    .union([z.literal(""), z.string().trim().toLowerCase().email("Email i pavlefshëm.").max(200)])
    .nullish()
    .transform((v) => v || null),
  birthDate: z
    .union([z.literal(""), dateParam])
    .nullish()
    .transform((v) => v || null),
  note: optionalText(2000),
};
const patientCreate = z.object({ ...patientFields, dentistId: z.number().int().positive().optional() });
const patientPatch = z.object({ ...patientFields, dentistId: z.number().int().positive() }).partial();

const appointmentCreate = z
  .object({
    dentistId: z.number().int().positive(),
    serviceId: z.number().int().positive(),
    startsAt: z.coerce.date(),
    patientId: z.number().int().positive().optional(),
    newPatient: z.object(patientFields).optional(),
  })
  .refine((v) => Boolean(v.patientId) !== Boolean(v.newPatient), "Zgjidhni një pacient ekzistues ose shtoni një të ri.");

const cancelSchema = z.object({
  reason: optionalText(300),
  /** Must be true to cancel with less warning than the clinic promises its patients. */
  confirmLate: z.boolean().default(false),
});

const reportSchema = z.object({
  workDone: z.string().trim().min(2, "Shkruani çfarë u punua.").max(5000),
  nextVisitDays: z.number().int().min(1).max(730).nullable().default(null),
});

interface AppointmentRow {
  id: number;
  clinic_id: number;
  dentist_id: number;
  patient_id: number;
  service_id: number;
  starts_at: Date;
  ends_at: Date;
  status: "booked" | "completed" | "no_show" | "cancelled";
  source: "online" | "local";
  cancelled_at: Date | null;
  cancelled_by: "clinic" | "patient" | null;
  cancel_reason: string | null;
  cancel_late: boolean;
  patient_name: string;
  patient_phone: string | null;
  patient_email: string | null;
  dentist_name: string;
  service_name: string;
  has_report: boolean;
  last_email_status: string | null;
}

const APPOINTMENT_SELECT = `
  SELECT a.id, a.clinic_id, a.dentist_id, a.patient_id, a.service_id, a.starts_at, a.ends_at, a.status, a.source,
         a.cancelled_at, a.cancelled_by, a.cancel_reason, a.cancel_late,
         p.full_name AS patient_name, p.phone AS patient_phone, p.email AS patient_email,
         u.full_name AS dentist_name, s.name AS service_name,
         EXISTS (SELECT 1 FROM visit_reports vr WHERE vr.appointment_id = a.id) AS has_report,
         (SELECT e.status FROM email_log e WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1) AS last_email_status
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN users u ON u.id = a.dentist_id
    JOIN services s ON s.id = a.service_id`;

const mapAppointment = (a: AppointmentRow) => ({
  id: a.id,
  dentistId: a.dentist_id,
  dentistName: a.dentist_name,
  patientId: a.patient_id,
  patientName: a.patient_name,
  patientPhone: a.patient_phone,
  patientEmail: a.patient_email,
  serviceId: a.service_id,
  serviceName: a.service_name,
  startsAt: a.starts_at,
  endsAt: a.ends_at,
  status: a.status,
  source: a.source,
  cancelledAt: a.cancelled_at,
  cancelledBy: a.cancelled_by,
  cancelReason: a.cancel_reason,
  cancelLate: a.cancel_late,
  hasReport: a.has_report,
  lastEmailStatus: a.last_email_status,
});

/**
 * SQL condition: which appointments this user may see or act on. Needs the aliases `a` (appointments) and
 * `p` (patients). `$u` holds the user's id, `$since` the instant from treatingAccessSince() and `$now` the
 * current instant.
 * A dentist keeps an appointment they treat while the patient is theirs, while it is still booked, or for a
 * few days after it started (time to write and correct the report). One that has not started and is no
 * longer booked (cancelled, say) has no work left on it, so that last branch stops at now.
 */
const appointmentScope = (user: SessionUser, u: number, since: number, now: number) =>
  // The administrator branch still mentions the parameters, so PostgreSQL can give them a type.
  user.role === "admin"
    ? `($${u}::int IS NOT NULL AND $${since}::timestamptz IS NOT NULL AND $${now}::timestamptz IS NOT NULL)`
    : `(a.dentist_id = $${u} AND (p.dentist_id = $${u} OR a.status = 'booked' OR (a.starts_at >= $${since}::timestamptz AND a.starts_at <= $${now}::timestamptz)))`;

/** The appointment, if it exists in the requester's clinic and the requester may work with it. */
async function appointmentFor(q: Queryer, user: SessionUser, id: number, now: Date): Promise<AppointmentRow> {
  const rows = await q.query<AppointmentRow>(`${APPOINTMENT_SELECT} WHERE a.id = $1 AND a.clinic_id = $2 AND ${appointmentScope(user, 3, 4, 5)}`, [
    id,
    user.clinicId,
    user.id,
    treatingAccessSince(now),
    now,
  ]);
  // "Not yours" and "does not exist" look the same, so ids cannot be probed.
  if (!rows[0]) throw new HttpError(404, "Termini nuk u gjet.");
  return rows[0];
}

interface PatientRow {
  id: number;
  dentist_id: number;
  dentist_name: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  birth_date: string | Date | null;
  note: string | null;
  source: "online" | "local";
  created_at: Date;
}

const PATIENT_SELECT = `
  SELECT p.id, p.dentist_id, u.full_name AS dentist_name, p.full_name, p.phone, p.email,
         to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date, p.note, p.source, p.created_at
    FROM patients p JOIN users u ON u.id = p.dentist_id`;

/**
 * SQL condition: which patients this user may see. `$n` is the parameter holding the user's id.
 * Only the dentist responsible today: an earlier appointment with the patient is not enough.
 */
const patientScope = (user: SessionUser, n: number) =>
  // The administrator branch still mentions the parameter, so PostgreSQL can give it a type.
  user.role === "admin" ? `($${n}::int IS NOT NULL)` : `(p.dentist_id = $${n})`;

const mapPatient = (p: PatientRow) => ({
  id: p.id,
  dentistId: p.dentist_id,
  dentistName: p.dentist_name,
  fullName: p.full_name,
  phone: p.phone,
  email: p.email,
  birthDate: p.birth_date,
  note: p.note,
  source: p.source,
  createdAt: p.created_at,
});

async function patientFor(q: Queryer, user: SessionUser, id: number): Promise<PatientRow> {
  const rows = await q.query<PatientRow>(`${PATIENT_SELECT} WHERE p.id = $1 AND p.clinic_id = $2 AND ${patientScope(user, 3)}`, [id, user.clinicId, user.id]);
  if (!rows[0]) throw new HttpError(404, "Pacienti nuk u gjet.");
  return rows[0];
}

export function staffRoutes(ctx: Ctx): Router {
  const r = Router();

  // ---- calendar -------------------------------------------------------------------------------------

  // The appointments of one day. Also the first step of the report flow (owner's rule 6): pick a date,
  // see that day's patients, narrow by name with `q`.
  r.get("/appointments", async (req, res) => {
    const user = requireUser(req);
    const query = parse(z.object({ date: dateParam, dentistId: z.coerce.number().int().positive().optional(), q: z.string().trim().max(80).optional() }), req.query);
    const clinic = await clinicById(ctx.db, user.clinicId);
    const day = dayBounds(query.date, clinic.timezone);
    const now = ctx.now();
    const params: unknown[] = [user.clinicId, day.start, day.end, user.id, treatingAccessSince(now), now];
    // A dentist always gets their own day, whatever the request asks for: the scope pins it.
    let where = `a.clinic_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3 AND ${appointmentScope(user, 4, 5, 6)}`;
    if (user.role === "admin" && query.dentistId) where += ` AND a.dentist_id = $${params.push(query.dentistId)}`;
    if (query.q) where += ` AND p.full_name ILIKE $${params.push(`%${query.q.replace(/[%_\\]/g, "\\$&")}%`)}`;
    const rows = await ctx.db.query<AppointmentRow>(`${APPOINTMENT_SELECT} WHERE ${where} ORDER BY a.starts_at, a.id`, params);
    res.json({ appointments: rows.map(mapAppointment) });
  });

  // How many appointments each day of a short period has (cancelled ones not counted): the week strip above
  // the calendar. Read-only, at most 31 days, and scoped exactly like the day list above: a dentist's
  // numbers are their own appointments, the administrator's are the clinic's or one dentist's.
  // Declared before "/appointments/:id" so that "counts" is not taken for an id.
  r.get("/appointments/counts", async (req, res) => {
    const user = requireUser(req);
    const query = parse(z.object({ from: dateParam, days: z.coerce.number().int().min(1).max(31).default(7), dentistId: z.coerce.number().int().positive().optional() }), req.query);
    const clinic = await clinicById(ctx.db, user.clinicId);
    const dates = Array.from({ length: query.days }, (_, i) => addDays(query.from, i));
    const now = ctx.now();
    const params: unknown[] = [user.clinicId, dayBounds(dates[0]!, clinic.timezone).start, dayBounds(dates[dates.length - 1]!, clinic.timezone).end, user.id, treatingAccessSince(now), now];
    let where = `a.clinic_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3 AND a.status <> 'cancelled' AND ${appointmentScope(user, 4, 5, 6)}`;
    if (user.role === "admin" && query.dentistId) where += ` AND a.dentist_id = $${params.push(query.dentistId)}`;
    const rows = await ctx.db.query<{ starts_at: Date }>(`SELECT a.starts_at FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE ${where}`, params);
    // Counted per day of the clinic's calendar, not the server's: an appointment late in the evening
    // belongs to the day the clinic sees it on.
    const counts = new Map(dates.map((d) => [d, 0]));
    for (const row of rows) {
      const day = localDate(new Date(row.starts_at), clinic.timezone);
      if (counts.has(day)) counts.set(day, counts.get(day)! + 1);
    }
    res.json({ days: dates.map((date) => ({ date, count: counts.get(date)! })) });
  });

  r.get("/appointments/:id", async (req, res) => {
    const user = requireUser(req);
    const a = await appointmentFor(ctx.db, user, idParam(req.params.id), ctx.now());
    const report = await ctx.db.query<{ work_done: string; next_visit_days: number | null; version: number; author_name: string; updated_at: Date }>(
      `SELECT vr.work_done, vr.next_visit_days, vr.version, u.full_name AS author_name, vr.updated_at
         FROM visit_reports vr JOIN users u ON u.id = vr.author_id WHERE vr.appointment_id = $1`,
      [a.id],
    );
    const versions = await ctx.db.query<{ version: number; work_done: string; next_visit_days: number | null; author_name: string; saved_at: Date }>(
      `SELECT v.version, v.work_done, v.next_visit_days, u.full_name AS author_name, v.saved_at
         FROM visit_report_versions v JOIN users u ON u.id = v.author_id WHERE v.appointment_id = $1 ORDER BY v.version DESC`,
      [a.id],
    );
    const r0 = report[0];
    res.json({
      appointment: mapAppointment(a),
      report: r0 ? { workDone: r0.work_done, nextVisitDays: r0.next_visit_days, version: r0.version, authorName: r0.author_name, updatedAt: r0.updated_at } : null,
      versions: versions.map((v) => ({ version: v.version, workDone: v.work_done, nextVisitDays: v.next_visit_days, authorName: v.author_name, savedAt: v.saved_at })),
    });
  });

  // Free start times of one dentist on one day, for the staff booking form. No 36-hour rule here: that rule
  // is about patients booking by themselves.
  r.get("/slots", async (req, res) => {
    const user = requireUser(req);
    const query = parse(z.object({ dentistId: z.coerce.number().int().positive(), serviceId: z.coerce.number().int().positive(), date: dateParam }), req.query);
    if (user.role !== "admin" && query.dentistId !== user.id) throw new HttpError(403, "Mund të caktoni termine vetëm për veten.");
    const clinic = await clinicById(ctx.db, user.clinicId);
    const service = await activeService(ctx.db, clinic.id, query.serviceId);
    const dentist = await bookableDentist(ctx.db, clinic.id, query.dentistId);
    const free = await availability(ctx.db, { clinic, service, dentistIds: [dentist.id], fromDate: query.date, days: 1, notBefore: ctx.now() });
    res.json({ slots: (free.get(query.date) ?? []).map((s) => s.startsAt) });
  });

  // Books an appointment for a local patient (owner's rule 4), existing or added on the spot.
  r.post("/appointments", async (req, res) => {
    const user = requireUser(req);
    const input = parse(appointmentCreate, req.body);
    if (user.role !== "admin" && input.dentistId !== user.id) throw new HttpError(403, "Mund të caktoni termine vetëm për veten.");
    const now = ctx.now();
    // A walk-in can be recorded shortly after the fact, but not days later.
    if (input.startsAt.getTime() < now.getTime() - 12 * HOUR_MS) throw new HttpError(400, "Koha e terminit ka kaluar.", { startsAt: "Në të kaluarën" });

    const clinic = await clinicById(ctx.db, user.clinicId);
    const service = await activeService(ctx.db, clinic.id, input.serviceId);
    const dentist = await bookableDentist(ctx.db, clinic.id, input.dentistId);
    const endsAt = new Date(input.startsAt.getTime() + service.duration_minutes * 60000);
    const token = newToken();

    const appointmentId = await ctx.db.tx(async (q) => {
      let patientId: number;
      if (input.patientId) {
        patientId = (await patientFor(q, user, input.patientId)).id;
      } else {
        const p = input.newPatient!;
        const created = await q.query<{ id: number }>(
          `INSERT INTO patients (clinic_id, dentist_id, full_name, phone, email, birth_date, note, source, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'local', $8) RETURNING id`,
          [clinic.id, dentist.id, p.fullName, p.phone ? normalizePhone(p.phone) : null, p.email, p.birthDate, p.note, user.id],
        );
        patientId = created[0]!.id;
      }
      return insertAppointment(q, {
        clinicId: clinic.id,
        dentistId: dentist.id,
        patientId,
        serviceId: service.id,
        startsAt: input.startsAt,
        endsAt,
        source: "local",
        noticeAcceptedAt: null,
        tokenHash: hashToken(token),
        createdBy: user.id,
      });
    });
    await audit(ctx.db, { clinicId: clinic.id, userId: user.id, action: "appointment_booked_by_clinic", entity: "appointment", entityId: appointmentId });
    // A future appointment is confirmed by email when the patient has an address; a walk-in already here is not.
    const emailStatus = input.startsAt > now ? await notifyBooked(ctx, appointmentId, token) : "no_email";
    res.status(201).json({ id: appointmentId, emailStatus });
  });

  // The clinic cancels (owner's rules 1 and 3). The patient is told by email; when that is impossible the
  // answer says so and carries the phone number, so staff can call.
  r.post("/appointments/:id/cancel", async (req, res) => {
    const user = requireUser(req);
    const input = parse(cancelSchema, req.body ?? {});
    const now = ctx.now();
    const a = await appointmentFor(ctx.db, user, idParam(req.params.id), now);
    if (a.status !== "booked") throw new HttpError(409, "Ky termin nuk është më aktiv.");
    if (new Date(a.starts_at) <= now) throw new HttpError(409, "Termini ka filluar. Nëse pacienti nuk erdhi, shënojeni \"Nuk erdhi\".");

    const clinic = await clinicById(ctx.db, user.clinicId);
    const late = new Date(a.starts_at).getTime() - now.getTime() < clinic.cancel_notice_hours * HOUR_MS;
    if (late && !(input.confirmLate && input.reason)) {
      // The clinic promised its patients more warning than this. It can still cancel (emergencies happen),
      // but only knowingly and with a reason on record.
      res.status(409).json({
        error: `Kanë mbetur më pak se ${clinic.cancel_notice_hours} orë deri në termin. Klinika u ka premtuar pacientëve njoftim ${clinic.cancel_notice_hours} orë përpara. Për ta anuluar gjithsesi, shkruani arsyen dhe konfirmoni.`,
        code: "late_cancellation",
      });
      return;
    }

    const updated = await ctx.db.query(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = $2, cancelled_by = 'clinic', cancelled_by_user = $3, cancel_reason = $4, cancel_late = $5, token_hash = NULL
        WHERE id = $1 AND status = 'booked' RETURNING id`,
      [a.id, now, user.id, input.reason, late],
    );
    if (!updated.length) throw new HttpError(409, "Ky termin nuk është më aktiv.");
    await audit(ctx.db, { clinicId: user.clinicId, userId: user.id, action: "appointment_cancelled_by_clinic", entity: "appointment", entityId: a.id, meta: { late, reason: input.reason } });
    const emailStatus = await notifyCancelledByClinic(ctx, a.id);
    res.json({ ok: true, late, emailStatus, patientPhone: a.patient_phone, patientName: a.patient_name });
  });

  // After the visit: the patient came, or did not. "booked" undoes a mistaken mark.
  r.post("/appointments/:id/status", async (req, res) => {
    const user = requireUser(req);
    const { status } = parse(z.object({ status: z.enum(["completed", "no_show", "booked"]) }), req.body);
    const a = await appointmentFor(ctx.db, user, idParam(req.params.id), ctx.now());
    if (a.status === "cancelled") throw new HttpError(409, "Termini është anuluar.");
    if (status !== "booked" && new Date(a.starts_at) > ctx.now()) throw new HttpError(409, "Termini nuk ka filluar ende.");
    await ctx.db.query("UPDATE appointments SET status = $2 WHERE id = $1 AND status <> 'cancelled'", [a.id, status]);
    await audit(ctx.db, { clinicId: user.clinicId, userId: user.id, action: "appointment_status_changed", entity: "appointment", entityId: a.id, meta: { from: a.status, to: status } });
    res.json({ ok: true });
  });

  // ---- visit reports (owner's rule 6) ---------------------------------------------------------------

  r.put("/appointments/:id/report", async (req, res) => {
    const user = requireUser(req);
    const input = parse(reportSchema, req.body);
    const a = await appointmentFor(ctx.db, user, idParam(req.params.id), ctx.now());
    if (a.status === "cancelled") throw new HttpError(409, "Për një termin të anuluar nuk shkruhet raport.");
    const clinic = await clinicById(ctx.db, user.clinicId);
    // A report describes work that was done, so it cannot be written before the day of the visit.
    if (localDate(new Date(a.starts_at), clinic.timezone) > localDate(ctx.now(), clinic.timezone)) {
      throw new HttpError(409, "Raporti shkruhet në ditën e terminit ose më pas.");
    }
    const version = await ctx.db.tx(async (q) => {
      const rows = await q.query<{ version: number }>(
        `INSERT INTO visit_reports (appointment_id, work_done, next_visit_days, author_id, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (appointment_id) DO UPDATE
           SET work_done = EXCLUDED.work_done, next_visit_days = EXCLUDED.next_visit_days, author_id = EXCLUDED.author_id,
               updated_at = EXCLUDED.updated_at, version = visit_reports.version + 1
         RETURNING version`,
        [a.id, input.workDone, input.nextVisitDays, user.id, ctx.now()],
      );
      const v = rows[0]!.version;
      // Every save is kept: a clinical record is corrected by adding, never by overwriting.
      await q.query("INSERT INTO visit_report_versions (appointment_id, version, work_done, next_visit_days, author_id, saved_at) VALUES ($1, $2, $3, $4, $5, $6)", [
        a.id,
        v,
        input.workDone,
        input.nextVisitDays,
        user.id,
        ctx.now(),
      ]);
      // Writing what was done means the visit happened.
      await q.query("UPDATE appointments SET status = 'completed' WHERE id = $1 AND status = 'booked'", [a.id]);
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: v === 1 ? "report_created" : "report_edited", entity: "appointment", entityId: a.id, meta: { version: v } });
      return v;
    });
    res.json({ ok: true, version });
  });

  // Patients whose "next visit in N days" has come up (or is about to) and who have nothing booked.
  // A dentist gets the patients they are responsible for today, whoever wrote the report.
  // "In N days" means N calendar days on the clinic's wall clock: a visit at 09:00 is due at 09:00, also
  // across the change between summer and winter time. The days are therefore added in the clinic's
  // timezone, spelled out; left to the database's own session timezone the answer would depend on where the
  // database server happens to run.
  r.get("/due-visits", async (req, res) => {
    const user = requireUser(req);
    const now = ctx.now();
    const rows = await ctx.db.query<{ patient_id: number; patient_name: string; patient_phone: string | null; dentist_name: string; due_at: Date; work_done: string }>(
      `SELECT p.id AS patient_id, p.full_name AS patient_name, p.phone AS patient_phone, u.full_name AS dentist_name,
              due.at AS due_at, vr.work_done
         FROM visit_reports vr
         JOIN appointments a ON a.id = vr.appointment_id
         JOIN clinics c ON c.id = a.clinic_id
         JOIN patients p ON p.id = a.patient_id
         JOIN users u ON u.id = a.dentist_id
         CROSS JOIN LATERAL (
           SELECT ((a.starts_at AT TIME ZONE c.timezone) + make_interval(days => vr.next_visit_days)) AT TIME ZONE c.timezone AS at
         ) due
        WHERE a.clinic_id = $1 AND vr.next_visit_days IS NOT NULL
          AND ($2::int IS NULL OR p.dentist_id = $2)
          AND due.at BETWEEN $3 AND $4
          AND NOT EXISTS (SELECT 1 FROM appointments later WHERE later.patient_id = p.id AND later.status <> 'cancelled' AND later.starts_at > a.starts_at)
        ORDER BY due_at`,
      [user.clinicId, user.role === "admin" ? null : user.id, new Date(now.getTime() - 60 * 24 * HOUR_MS), new Date(now.getTime() + 14 * 24 * HOUR_MS)],
    );
    res.json({
      due: rows.map((d) => ({ patientId: d.patient_id, patientName: d.patient_name, patientPhone: d.patient_phone, dentistName: d.dentist_name, dueAt: d.due_at, lastWork: d.work_done })),
    });
  });

  // ---- patients -------------------------------------------------------------------------------------

  r.get("/patients", async (req, res) => {
    const user = requireUser(req);
    const query = parse(z.object({ q: z.string().trim().max(80).optional() }), req.query);
    const params: unknown[] = [user.clinicId, user.id];
    let where = `p.clinic_id = $1 AND ${patientScope(user, 2)}`;
    if (query.q) {
      const like = `%${query.q.replace(/[%_\\]/g, "\\$&")}%`;
      where += ` AND (p.full_name ILIKE $${params.push(like)} OR p.phone ILIKE $${params.length} OR p.email ILIKE $${params.length})`;
    }
    const rows = await ctx.db.query<PatientRow>(`${PATIENT_SELECT} WHERE ${where} ORDER BY p.full_name LIMIT 200`, params);
    res.json({ patients: rows.map(mapPatient) });
  });

  r.post("/patients", async (req, res) => {
    const user = requireUser(req);
    const input = parse(patientCreate, req.body);
    // A dentist's new patient is their own; an administrator names the responsible dentist.
    const dentistId = user.role === "admin" ? (input.dentistId ?? user.id) : user.id;
    const dentist = await bookableDentist(ctx.db, user.clinicId, dentistId);
    const rows = await ctx.db.query<{ id: number }>(
      `INSERT INTO patients (clinic_id, dentist_id, full_name, phone, email, birth_date, note, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'local', $8) RETURNING id`,
      [user.clinicId, dentist.id, input.fullName, input.phone ? normalizePhone(input.phone) : null, input.email, input.birthDate, input.note, user.id],
    );
    await audit(ctx.db, { clinicId: user.clinicId, userId: user.id, action: "patient_created", entity: "patient", entityId: rows[0]!.id });
    res.status(201).json({ patient: mapPatient(await patientFor(ctx.db, user, rows[0]!.id)) });
  });

  // A patient with their whole history, reports included, whichever dentist treated them: the responsible
  // dentist needs it to continue the care. patientFor has already refused everyone else.
  r.get("/patients/:id", async (req, res) => {
    const user = requireUser(req);
    const patient = await patientFor(ctx.db, user, idParam(req.params.id));
    const visits = await ctx.db.query<AppointmentRow & { work_done: string | null; next_visit_days: number | null }>(
      `${APPOINTMENT_SELECT.replace("FROM appointments a", ", vr2.work_done, vr2.next_visit_days FROM appointments a LEFT JOIN visit_reports vr2 ON vr2.appointment_id = a.id")}
        WHERE a.patient_id = $1 AND a.clinic_id = $2
        ORDER BY a.starts_at DESC`,
      [patient.id, user.clinicId],
    );
    res.json({
      patient: mapPatient(patient),
      visits: visits.map((v) => ({ ...mapAppointment(v), workDone: v.work_done, nextVisitDays: v.next_visit_days })),
    });
  });

  r.patch("/patients/:id", async (req, res) => {
    const user = requireUser(req);
    const input = parse(patientPatch, req.body);
    const patient = await patientFor(ctx.db, user, idParam(req.params.id));
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => sets.push(`${column} = $${params.push(value)}`);
    if (input.fullName !== undefined) set("full_name", input.fullName);
    if (input.phone !== undefined) set("phone", input.phone ? normalizePhone(input.phone) : null);
    if (input.email !== undefined) set("email", input.email);
    if (input.birthDate !== undefined) set("birth_date", input.birthDate);
    if (input.note !== undefined) set("note", input.note);
    if (input.dentistId !== undefined && input.dentistId !== patient.dentist_id) {
      if (user.role !== "admin") throw new HttpError(403, "Vetëm administratori mund ta ndryshojë stomatologun përgjegjës.");
      set("dentist_id", (await bookableDentist(ctx.db, user.clinicId, input.dentistId)).id);
    }
    if (sets.length) {
      set("updated_at", ctx.now());
      await ctx.db.query(`UPDATE patients SET ${sets.join(", ")} WHERE id = $${params.push(patient.id)}`, params);
      await audit(ctx.db, { clinicId: user.clinicId, userId: user.id, action: "patient_updated", entity: "patient", entityId: patient.id, meta: { fields: Object.keys(input) } });
    }
    res.json({ patient: mapPatient(await patientFor(ctx.db, user, patient.id)) });
  });

  // ---- numbers and logs -----------------------------------------------------------------------------

  r.get("/stats", async (req, res) => {
    const user = requireUser(req);
    const query = parse(z.object({ from: dateParam, to: dateParam }), req.query);
    const clinic = await clinicById(ctx.db, user.clinicId);
    const from = dayBounds(query.from, clinic.timezone).start;
    const to = dayBounds(query.to, clinic.timezone).end;
    const rows = await ctx.db.query<{ total: number; booked: number; completed: number; no_show: number; cancelled_by_clinic: number; cancelled_by_patient: number; late: number; online: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'booked')::int AS booked,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status = 'no_show')::int AS no_show,
              count(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'clinic')::int AS cancelled_by_clinic,
              count(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'patient')::int AS cancelled_by_patient,
              count(*) FILTER (WHERE cancel_late)::int AS late,
              count(*) FILTER (WHERE source = 'online')::int AS online
         FROM appointments
        WHERE clinic_id = $1 AND starts_at >= $2 AND starts_at < $3 AND ($4::int IS NULL OR dentist_id = $4)`,
      [user.clinicId, from, to, user.role === "admin" ? null : user.id],
    );
    const s = rows[0]!;
    res.json({
      stats: {
        total: s.total,
        booked: s.booked,
        completed: s.completed,
        noShow: s.no_show,
        cancelledByClinic: s.cancelled_by_clinic,
        cancelledByPatient: s.cancelled_by_patient,
        lateCancellations: s.late,
        online: s.online,
        local: s.total - s.online,
      },
    });
  });

  // The outbox: every email with its outcome. Without a mail server configured, this is where messages are read.
  // A dentist sees the emails of appointments they may open; an email tied to no appointment is the
  // administrator's alone.
  r.get("/emails", async (req, res) => {
    const user = requireUser(req);
    const rows = await ctx.db.query<{ id: number; to_email: string; kind: string; subject: string; body: string; status: string; error: string | null; created_at: Date; attempts: number; last_attempt_at: Date | null; worth_sending: boolean }>(
      `SELECT e.id, e.to_email, e.kind, e.subject, e.body, e.status, e.error, e.created_at, e.attempts, e.last_attempt_at,
              ${stillWorthSending(4)} AS worth_sending
         FROM email_log e
         LEFT JOIN appointments a ON a.id = e.appointment_id
         LEFT JOIN patients p ON p.id = a.patient_id
        WHERE e.clinic_id = $1 AND ${appointmentScope(user, 2, 3, 4)}
        ORDER BY e.id DESC LIMIT 100`,
      [user.clinicId, user.id, treatingAccessSince(ctx.now()), ctx.now()],
    );
    res.json({
      // Whether a mail server is configured at all: without one, "send again" cannot work.
      canSend: ctx.mailer !== null,
      emails: rows.map((e) => ({
        id: e.id,
        to: e.to_email,
        kind: e.kind,
        subject: e.subject,
        body: e.body,
        status: e.status,
        error: e.error,
        createdAt: e.created_at,
        attempts: e.attempts,
        lastAttemptAt: e.last_attempt_at,
        // Not yet with the mail server, and the appointment it is about has not passed or been cancelled.
        canResend: e.status !== "accepted" && e.worth_sending,
      })),
    });
  });

  // Sends again a message that did not get through. Never one the mail server is known to have taken, and
  // not while an earlier attempt is still out or has just timed out (see attemptDelivery for what that
  // does and does not guarantee).
  r.post("/emails/:id/resend", async (req, res) => {
    const user = requireUser(req);
    const id = idParam(req.params.id);
    const now = ctx.now();
    const rows = await ctx.db.query<{ id: number; status: string; appointment_id: number | null; worth_sending: boolean }>(
      `SELECT e.id, e.status, e.appointment_id, ${stillWorthSending(5)} AS worth_sending
         FROM email_log e
         LEFT JOIN appointments a ON a.id = e.appointment_id
         LEFT JOIN patients p ON p.id = a.patient_id
        WHERE e.id = $1 AND e.clinic_id = $2 AND ${appointmentScope(user, 3, 4, 5)}`,
      [id, user.clinicId, user.id, treatingAccessSince(now), now],
    );
    const email = rows[0];
    if (!email) throw new HttpError(404, "Emaili nuk u gjet.");
    if (email.status === "accepted") throw new HttpError(409, "Ky email është pranuar tashmë nga serveri i emailit. Nuk dërgohet dy herë.");
    if (!email.worth_sending) throw new HttpError(409, "Termini i këtij emaili ka kaluar ose nuk është më aktiv, prandaj mesazhi nuk dërgohet më.");
    if (!ctx.mailer) throw new HttpError(409, "Serveri i emailit nuk është konfiguruar. Njoftojeni pacientin me telefon.");
    const status = await attemptDelivery(ctx.db, ctx.mailer, email.id, now);
    if (status === null) throw new HttpError(409, "Ky email po dërgohet, ose përpjekja e fundit mbeti pa përgjigje nga serveri i emailit. Provoni përsëri pas pesë minutash; për një anulim, telefonojeni pacientin.");
    await audit(ctx.db, { clinicId: user.clinicId, userId: user.id, action: "email_resent", entity: "appointment", entityId: email.appointment_id, meta: { emailId: email.id, status } });
    res.json({ status });
  });

  return r;
}
