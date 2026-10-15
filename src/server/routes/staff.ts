import { Router } from "express";
import { z } from "zod";
import { hashToken, newToken, requireAdmin, requireUser, type SessionUser } from "../auth";
import { activeService, availability, bookableDentist, insertAppointment, normalizePhone } from "../booking";
import { audit, clinicById, type Ctx } from "../context";
import { COMPLETED_WITHOUT_REPORT, NO_SHOW_WITH_REPORT, pgErrorCode, type Queryer } from "../db";
import { HttpError, idParam, parse } from "../errors";
import { isWholePicture } from "../imageCheck";
import { attemptDelivery, stillWorthSending, withoutLink } from "../mail";
import { handOver, notifyBooked, queueCancellation } from "../notify";
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
  deposit_mode: string | null;
  deposit_amount_minor: number | null;
  deposit_currency: string | null;
  bill_credit_minor: number;
}

const APPOINTMENT_SELECT = `
  SELECT a.id, a.clinic_id, a.dentist_id, a.patient_id, a.service_id, a.starts_at, a.ends_at, a.status, a.source,
         a.cancelled_at, a.cancelled_by, a.cancel_reason, a.cancel_late,
         a.deposit_mode, a.deposit_amount_minor, a.deposit_currency, a.bill_credit_minor,
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
  // What the dentist takes off the bill. "demo" means no money was collected: it is shown as such.
  deposit: a.deposit_mode ? { mode: a.deposit_mode, amountMinor: a.deposit_amount_minor, currency: a.deposit_currency, billCreditMinor: a.bill_credit_minor } : null,
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

  // Every report of one week (Monday to Sunday, in the clinic's own calendar), for the week that holds the
  // date asked for. With the count per day, so the page can list the week's dates and say which have reports.
  r.get("/reports/week", async (req, res) => {
    const user = requireUser(req);
    const query = parse(z.object({ date: dateParam }), req.query);
    const clinic = await clinicById(ctx.db, user.clinicId);
    // ISO weekday of the date, 1 (Monday) to 7, worked out on the calendar and not on any clock.
    const asked = new Date(`${query.date}T00:00:00Z`);
    const from = addDays(query.date, -((asked.getUTCDay() + 6) % 7));
    const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const now = ctx.now();
    const rows = await ctx.db.query<AppointmentRow & { work_done: string; next_visit_days: number | null; version: number; images: number }>(
      `${APPOINTMENT_SELECT.replace(
        "FROM appointments a",
        ", vr2.work_done, vr2.next_visit_days, vr2.version, (SELECT count(*)::int FROM visit_images vi WHERE vi.appointment_id = a.id) AS images FROM appointments a JOIN visit_reports vr2 ON vr2.appointment_id = a.id",
      )}
        WHERE a.clinic_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3 AND ${appointmentScope(user, 4, 5, 6)}
        ORDER BY a.starts_at, a.id`,
      [user.clinicId, dayBounds(from, clinic.timezone).start, dayBounds(dates[6]!, clinic.timezone).end, user.id, treatingAccessSince(now), now],
    );
    const reports = rows.map((v) => ({
      appointmentId: v.id,
      date: localDate(new Date(v.starts_at), clinic.timezone),
      startsAt: v.starts_at,
      patientName: v.patient_name,
      dentistName: v.dentist_name,
      serviceName: v.service_name,
      workDone: v.work_done,
      nextVisitDays: v.next_visit_days,
      version: v.version,
      images: v.images,
    }));
    res.json({ from, to: dates[6], days: dates.map((date) => ({ date, count: reports.filter((r) => r.date === date).length })), reports });
  });

  // The booked appointments of one month, in order: what is ahead for a dentist (or, for the administrator,
  // for the clinic or one dentist). Cancelled, finished and missed ones are not part of it. The same scope
  // as the day list pins a dentist to their own.
  r.get("/appointments/booked", async (req, res) => {
    const user = requireUser(req);
    const query = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Muaj i pavlefshëm."), dentistId: z.coerce.number().int().positive().optional() }), req.query);
    const clinic = await clinicById(ctx.db, user.clinicId);
    const first = dayBounds(`${query.month}-01`, clinic.timezone).start;
    const next = Number(query.month.slice(5, 7)) === 12 ? `${Number(query.month.slice(0, 4)) + 1}-01` : `${query.month.slice(0, 4)}-${String(Number(query.month.slice(5, 7)) + 1).padStart(2, "0")}`;
    const end = dayBounds(`${next}-01`, clinic.timezone).start;
    const now = ctx.now();
    const params: unknown[] = [user.clinicId, first, end, user.id, treatingAccessSince(now), now];
    let where = `a.clinic_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3 AND a.status = 'booked' AND ${appointmentScope(user, 4, 5, 6)}`;
    if (user.role === "admin" && query.dentistId) where += ` AND a.dentist_id = $${params.push(query.dentistId)}`;
    const rows = await ctx.db.query<AppointmentRow>(`${APPOINTMENT_SELECT} WHERE ${where} ORDER BY a.starts_at, a.id`, params);
    res.json({ appointments: rows.map(mapAppointment) });
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

    // One transaction: the appointment is cancelled, every link to it is dead, the audit log says who did it,
    // and the message to the patient is written down. A server that stops right after still owes the patient
    // nothing that is not on record. Of two cancellations at the same moment, one finds it already done.
    const emailId = await ctx.db.tx(async (q) => {
      const updated = await q.query(
        `UPDATE appointments
            SET status = 'cancelled', cancelled_at = $2, cancelled_by = 'clinic', cancelled_by_user = $3, cancel_reason = $4, cancel_late = $5, token_hash = NULL, mail_token_hashes = '{}'
          WHERE id = $1 AND status = 'booked' RETURNING id`,
        [a.id, now, user.id, input.reason, late],
      );
      if (!updated.length) throw new HttpError(409, "Ky termin nuk është më aktiv.");
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: "appointment_cancelled_by_clinic", entity: "appointment", entityId: a.id, meta: { late, reason: input.reason } });
      return queueCancellation(ctx, q, a.id, "clinic");
    });
    // Only now, with the cancellation committed, is the mail server spoken to.
    const emailStatus = await handOver(ctx, emailId);
    res.json({ ok: true, late, emailStatus, patientPhone: a.patient_phone, patientName: a.patient_name });
  });

  // After the visit: the patient came, or did not. "booked" undoes a mistaken mark.
  r.post("/appointments/:id/status", async (req, res) => {
    const user = requireUser(req);
    const { status } = parse(z.object({ status: z.enum(["completed", "no_show", "booked"]) }), req.body);
    const a = await appointmentFor(ctx.db, user, idParam(req.params.id), ctx.now());
    if (a.status === "cancelled") throw new HttpError(409, "Termini është anuluar.");
    if (status !== "booked" && new Date(a.starts_at) > ctx.now()) throw new HttpError(409, "Termini nuk ka filluar ende.");
    // Owner's rule 6: a visit that took place has a report. "Completed" is therefore not something to press:
    // it is what saving the report does. It can be set here only for a visit whose report already exists
    // (a mark taken off by mistake and put back).
    const needsReport = new HttpError(409, "Vizita shënohet e kryer kur ruhet raporti i saj. Shkruani raportin e vizitës.", { status: "Mungon raporti" });
    // A report says what was done at the visit: "did not come" cannot stand beside it. (A mark set by
    // mistake is undone with "booked".)
    const hasReport = new HttpError(409, "Kjo vizitë ka raport, pra pacienti erdhi. Nuk mund të shënohet se nuk erdhi.", { status: "Ka raport" });
    const reported = (await ctx.db.query("SELECT 1 FROM visit_reports WHERE appointment_id = $1", [a.id])).length > 0;
    if (status === "completed" && !reported) throw needsReport;
    if (status === "no_show" && reported) throw hasReport;
    try {
      // The mark and its line in the audit log together. The database checks the rule once more as this
      // commits: a report cannot vanish between the look above and the mark.
      await ctx.db.tx(async (q) => {
        await q.query("UPDATE appointments SET status = $2 WHERE id = $1 AND status <> 'cancelled'", [a.id, status]);
        await audit(q, { clinicId: user.clinicId, userId: user.id, action: "appointment_status_changed", entity: "appointment", entityId: a.id, meta: { from: a.status, to: status } });
      });
    } catch (err) {
      if (pgErrorCode(err) === COMPLETED_WITHOUT_REPORT) throw needsReport;
      if (pgErrorCode(err) === NO_SHOW_WITH_REPORT) throw hasReport;
      throw err;
    }
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
      // Writing what was done means the visit happened, also when it had been marked "did not come" before.
      await q.query("UPDATE appointments SET status = 'completed' WHERE id = $1 AND status IN ('booked', 'no_show')", [a.id]);
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
    // Each visit's pictures, by the address they are fetched from. Somebody who may see the patient may see them.
    const pictures = await ctx.db.query<{ id: number; appointment_id: number; kind: string; caption: string | null }>(
      "SELECT i.id, i.appointment_id, i.kind, i.caption FROM visit_images i JOIN appointments a ON a.id = i.appointment_id WHERE a.patient_id = $1 AND a.clinic_id = $2 ORDER BY i.id",
      [patient.id, user.clinicId],
    );
    res.json({
      patient: mapPatient(patient),
      visits: visits.map((v) => ({
        ...mapAppointment(v),
        workDone: v.work_done,
        nextVisitDays: v.next_visit_days,
        images: pictures.filter((i) => i.appointment_id === v.id).map((i) => ({ id: i.id, kind: i.kind, caption: i.caption, url: `/api/images/${i.id}` })),
      })),
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
        // Staff are told that the message carries the patient's link, never where the link would go.
        body: withoutLink(e.body),
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


  // ---- pictures of a visit (X-rays, photographs) -------------------------------------------------------
  //
  // They are part of the visit's record. Whoever may work with the appointment may add and see its pictures;
  // the dentist responsible for the patient sees the pictures of ALL the patient's visits (that is what makes
  // an old X-ray appear at a later visit), exactly as that dentist sees the reports of those visits.

  interface ImageRow {
    id: number;
    appointment_id: number;
    kind: "xray" | "photo";
    caption: string | null;
    content_type: string;
    size_bytes: number;
    uploaded_by: number;
    uploader_name: string;
    created_at: Date;
    starts_at: Date;
  }
  const IMAGE_SELECT = `SELECT i.id, i.appointment_id, i.kind, i.caption, i.content_type, i.size_bytes, i.uploaded_by, up.full_name AS uploader_name, i.created_at, a.starts_at
      FROM visit_images i JOIN appointments a ON a.id = i.appointment_id JOIN patients p ON p.id = a.patient_id JOIN users up ON up.id = i.uploaded_by`;
  const mapImage = (i: ImageRow) => ({
    id: i.id,
    appointmentId: i.appointment_id,
    kind: i.kind,
    caption: i.caption,
    sizeBytes: i.size_bytes,
    uploadedBy: i.uploader_name,
    createdAt: i.created_at,
    visitAt: i.starts_at,
    url: `/api/images/${i.id}`,
  });
  /** The pictures somebody may see: those of appointments they may work with, and of patients who are theirs. */
  const imageScope = (user: SessionUser, u: number, since: number, now: number) => `(${appointmentScope(user, u, since, now)} OR ${patientScope(user, u)})`;

  // Pictures are kept in the database, where room is scarce (see migration 011): three ceilings.
  const MAX_IMAGE_BYTES = 1_048_576; // 1 MB each
  const MAX_IMAGES_PER_VISIT = 6;
  const MAX_CLINIC_IMAGE_BYTES = 120 * 1_048_576; // all of the clinic's pictures together
  const imageSchema = z
    .object({
      kind: z.enum(["xray", "photo"]),
      caption: z.string().trim().max(200).nullable().default(null),
      contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      // Base64 of the picture. Four characters carry three bytes.
      data: z.string().min(16).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Fotografia nuk u lexua dot."),
    })
    .strict();

  // Tests lower the clinic's ceiling to reach it with a few small pictures.
  const maxClinicImageBytes = () => Number(process.env.TEST_MAX_CLINIC_IMAGE_BYTES) > 0 && process.env.NODE_ENV === "test" ? Number(process.env.TEST_MAX_CLINIC_IMAGE_BYTES) : MAX_CLINIC_IMAGE_BYTES;

  // The pictures of this visit and, for whoever may see the patient's history, of the earlier visits.
  r.get("/appointments/:id/images", async (req, res) => {
    const user = requireUser(req);
    const now = ctx.now();
    const a = await appointmentFor(ctx.db, user, idParam(req.params.id), now);
    const rows = await ctx.db.query<ImageRow>(
      `${IMAGE_SELECT} WHERE a.patient_id = $1 AND a.clinic_id = $2 AND (a.id = $3 OR ${patientScope(user, 4)}) ORDER BY a.starts_at DESC, i.id`,
      [a.patient_id, user.clinicId, a.id, user.id],
    );
    res.json({
      images: rows.filter((i) => i.appointment_id === a.id).map(mapImage),
      earlier: rows.filter((i) => i.appointment_id !== a.id && new Date(i.starts_at) < new Date(a.starts_at)).map(mapImage),
      limit: MAX_IMAGES_PER_VISIT,
    });
  });

  r.post("/appointments/:id/images", async (req, res) => {
    const user = requireUser(req);
    const input = parse(imageSchema, req.body);
    const now = ctx.now();
    const a = await appointmentFor(ctx.db, user, idParam(req.params.id), now);
    // The same two rules as the report: nothing for a cancelled appointment, nothing before the day of the visit.
    if (a.status === "cancelled") throw new HttpError(409, "Për një termin të anuluar nuk shtohen fotografi.");
    const clinic = await clinicById(ctx.db, user.clinicId);
    if (localDate(new Date(a.starts_at), clinic.timezone) > localDate(now, clinic.timezone)) throw new HttpError(409, "Fotografitë shtohen në ditën e terminit ose më pas.");
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Fotografia është shumë e madhe. Më e shumta 1 MB.");
    // The whole file, to its last byte, must be one picture of the kind it claims (imageCheck.ts).
    if (!isWholePicture(bytes, input.contentType)) throw new HttpError(400, "Ky skedar nuk është fotografi JPEG, PNG ose WebP.", { data: "Jo fotografi" });
    const id = await ctx.db.tx(async (q) => {
      // Counted under a lock on the appointment: two uploads at once cannot both be "the eighth".
      await q.query("SELECT 1 FROM appointments WHERE id = $1 FOR UPDATE", [a.id]);
      const have = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM visit_images WHERE appointment_id = $1", [a.id]))[0]!.n;
      if (have >= MAX_IMAGES_PER_VISIT) throw new HttpError(409, `Një vizitë mban më së shumti ${MAX_IMAGES_PER_VISIT} fotografi.`);
      // The clinic's ceiling is one sum for all visits: uploads to different visits must wait for each other
      // here, or two of them would both read the same total and both fit. Held until this transaction ends.
      await q.query("SELECT pg_advisory_xact_lock(hashtext('visit_images_total'), $1)", [user.clinicId]);
      const kept = (await q.query<{ n: number }>("SELECT coalesce(sum(size_bytes), 0)::float8 AS n FROM visit_images WHERE clinic_id = $1", [user.clinicId]))[0]!.n;
      if (kept + bytes.length > maxClinicImageBytes()) throw new HttpError(409, "Hapësira për fotografi është mbushur. Hiqni fotografi që nuk duhen më, ose flisni me administratorin.");
      const made = await q.query<{ id: number }>(
        "INSERT INTO visit_images (clinic_id, appointment_id, kind, caption, content_type, size_bytes, data_base64, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        [user.clinicId, a.id, input.kind, input.caption || null, input.contentType, bytes.length, bytes.toString("base64"), user.id, now],
      );
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: "visit_image_added", entity: "appointment", entityId: a.id, meta: { imageId: made[0]!.id, kind: input.kind, bytes: bytes.length } });
      return made[0]!.id;
    });
    res.status(201).json({ id });
  });

  // The picture itself. Only to somebody signed in who may see it; never kept by a shared cache; never
  // read by the browser as anything but the kind of picture it is.
  r.get("/images/:id", async (req, res) => {
    const user = requireUser(req);
    const now = ctx.now();
    const rows = await ctx.db.query<{ content_type: string; data_base64: string }>(
      `SELECT i.content_type, i.data_base64 FROM visit_images i JOIN appointments a ON a.id = i.appointment_id JOIN patients p ON p.id = a.patient_id
        WHERE i.id = $1 AND a.clinic_id = $2 AND ${imageScope(user, 3, 4, 5)}`,
      [idParam(req.params.id), user.clinicId, user.id, treatingAccessSince(now), now],
    );
    if (!rows[0]) throw new HttpError(404, "Fotografia nuk u gjet.");
    res.setHeader("Content-Type", rows[0].content_type);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.end(Buffer.from(rows[0].data_base64, "base64"));
  });

  // Taken off by whoever added it, or by the administrator. It is on record that there was one.
  r.delete("/images/:id", async (req, res) => {
    const user = requireUser(req);
    const now = ctx.now();
    const rows = await ctx.db.query<ImageRow>(`${IMAGE_SELECT} WHERE i.id = $1 AND a.clinic_id = $2 AND ${imageScope(user, 3, 4, 5)}`, [idParam(req.params.id), user.clinicId, user.id, treatingAccessSince(now), now]);
    const image = rows[0];
    if (!image) throw new HttpError(404, "Fotografia nuk u gjet.");
    if (user.role !== "admin" && image.uploaded_by !== user.id) throw new HttpError(403, "Fotografinë e heq ai që e ka shtuar, ose administratori.");
    await ctx.db.tx(async (q) => {
      await q.query("DELETE FROM visit_images WHERE id = $1", [image.id]);
      await audit(q, { clinicId: user.clinicId, userId: user.id, action: "visit_image_removed", entity: "appointment", entityId: image.appointment_id, meta: { imageId: image.id, kind: image.kind } });
    });
    res.json({ ok: true });
  });


  // ---- reviews ----------------------------------------------------------------------------------------
  // The administrator sees every review with the visit it is about, and decides which appear on the public
  // pages. A review's stars and words are never changed here.
  r.get("/reviews", async (req, res) => {
    const user = requireAdmin(req);
    const rows = await ctx.db.query<{ id: number; rating: number; comment: string | null; status: string; created_at: Date; dentist_name: string; patient_name: string; starts_at: Date; appointment_id: number }>(
      `SELECT v.id, v.rating, v.comment, v.status, v.created_at, u.full_name AS dentist_name, p.full_name AS patient_name, a.starts_at, v.appointment_id
         FROM dentist_reviews v JOIN users u ON u.id = v.dentist_id JOIN appointments a ON a.id = v.appointment_id JOIN patients p ON p.id = a.patient_id
        WHERE v.clinic_id = $1 ORDER BY (v.status = 'pending') DESC, v.created_at DESC LIMIT 200`,
      [user.clinicId],
    );
    res.json({
      reviews: rows.map((v) => ({ id: v.id, rating: v.rating, comment: v.comment, status: v.status, createdAt: v.created_at, dentistName: v.dentist_name, patientName: v.patient_name, visitAt: v.starts_at, appointmentId: v.appointment_id })),
    });
  });

  r.patch("/reviews/:id", async (req, res) => {
    const user = requireAdmin(req);
    const { status } = parse(z.object({ status: z.enum(["published", "hidden"]) }).strict(), req.body);
    const id = idParam(req.params.id);
    const done = await ctx.db.tx(async (q) => {
      // An administrator who is also the dentist the review is about does not decide that it is shown, when
      // the clinic has another administrator who can. In a clinic with one administrator there is nobody
      // else: it is allowed, and on record who published it. Hiding one's own is always allowed.
      if (status === "published") {
        const own = await q.query("SELECT 1 FROM dentist_reviews WHERE id = $1 AND clinic_id = $2 AND dentist_id = $3", [id, user.clinicId, user.id]);
        const others = own[0] ? await q.query("SELECT 1 FROM users WHERE clinic_id = $1 AND role = 'admin' AND is_active AND id <> $2 LIMIT 1", [user.clinicId, user.id]) : [];
        if (others[0]) throw new HttpError(403, "Vlerësimin për punën tuaj e publikon administratori tjetër.");
      }
      const rows = await q.query<{ id: number; appointment_id: number }>("UPDATE dentist_reviews SET status = $3, moderated_by = $4, moderated_at = $5 WHERE id = $1 AND clinic_id = $2 RETURNING id, appointment_id", [id, user.clinicId, status, user.id, ctx.now()]);
      if (rows[0]) await audit(q, { clinicId: user.clinicId, userId: user.id, action: status === "published" ? "review_published" : "review_hidden", entity: "appointment", entityId: rows[0].appointment_id, meta: { reviewId: id } });
      return rows[0];
    });
    if (!done) throw new HttpError(404, "Vlerësimi nuk u gjet.");
    res.json({ ok: true });
  });

  return r;
}
