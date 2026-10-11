import { Router } from "express";
import { z } from "zod";
import { hashToken, newToken } from "../auth";
import {
  SlotTakenError,
  activeService,
  availability,
  bookableDentist,
  bookableDentists,
  earliestOnlineStart,
  insertAppointment,
  lastOnlineDate,
  lockPatientEmail,
  normalizePhone,
} from "../booking";
import { addressOf, audit, type ClinicRow, type Ctx } from "../context";
import { HttpError, parse } from "../errors";
import { notifyBooked, notifyCancelledByPatient } from "../notify";
import { formatAlbanian, isIsoDate, localDate } from "../time";

// Everything a patient can reach without an account. Nothing here reveals whether a person is already a
// patient of the clinic, and nothing identifies a patient except to the holder of their private link.

const bookSchema = z.object({
  serviceId: z.number().int().positive(),
  /** null: any dentist who is free at that time. */
  dentistId: z.number().int().positive().nullable(),
  startsAt: z.coerce.date(),
  fullName: z.string().trim().min(3, "Shkruani emrin dhe mbiemrin.").max(120),
  phone: z
    .string()
    .trim()
    .min(6, "Shkruani numrin e telefonit.")
    .max(30)
    .regex(/^[+\d][\d\s()/-]+$/, "Numër telefoni i pavlefshëm."),
  email: z.string().trim().toLowerCase().email("Email i pavlefshëm.").max(200),
  // Owner's rule 1: the patient must have seen and accepted the cancellation notice.
  acceptNotice: z.literal(true, { message: "Duhet ta pranoni njoftimin për anulimin." }),
});

/** A person may hold at most this many future appointments in one clinic through online booking. */
const MAX_OPEN_PER_EMAIL = 3;
const BOOKING_WINDOW_MS = 60 * 60 * 1000;

async function clinicBySlug(ctx: Ctx, slug: unknown): Promise<ClinicRow> {
  const rows = await ctx.db.query<ClinicRow>("SELECT * FROM clinics WHERE slug = $1", [String(slug)]);
  if (!rows[0]) throw new HttpError(404, "Klinika nuk u gjet.");
  return rows[0];
}

export function publicRoutes(ctx: Ctx): Router {
  const r = Router();

  // Bookings per address per hour, in memory: a booking page must not be usable to flood a clinic's calendar.
  async function throttle(ip: string, now: Date) {
    if (!(await ctx.limiter!.attempt("booking", ip, ctx.maxBookingsPerHour ?? 6, BOOKING_WINDOW_MS, now))) {
      throw new HttpError(429, "Shumë rezervime nga kjo pajisje. Provoni më vonë ose telefononi klinikën.");
    }
  }

  // What the booking page needs to draw itself.
  r.get("/clinics/:slug", async (req, res) => {
    const clinic = await clinicBySlug(ctx, req.params.slug);
    const [services, dentists] = await Promise.all([
      ctx.db.query<{ id: number; name: string; duration_minutes: number }>(
        "SELECT id, name, duration_minutes FROM services WHERE clinic_id = $1 AND is_active ORDER BY name",
        [clinic.id],
      ),
      bookableDentists(ctx.db, clinic.id),
    ]);
    const now = ctx.now();
    res.json({
      clinic: {
        slug: clinic.slug,
        name: clinic.name,
        phone: clinic.phone,
        address: clinic.address,
        timezone: clinic.timezone,
        bookingNoticeHours: clinic.booking_notice_hours,
        cancelNoticeHours: clinic.cancel_notice_hours,
      },
      services: services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes })),
      dentists: dentists.map((d) => ({ id: d.id, fullName: d.full_name })),
      firstDate: localDate(earliestOnlineStart(clinic, now), clinic.timezone),
      lastDate: lastOnlineDate(clinic, now),
    });
  });

  // Free start times for up to 14 consecutive days.
  r.get("/clinics/:slug/slots", async (req, res) => {
    const clinic = await clinicBySlug(ctx, req.params.slug);
    const query = parse(
      z.object({
        serviceId: z.coerce.number().int().positive(),
        dentistId: z.coerce.number().int().positive().optional(),
        from: z.string().refine(isIsoDate, "Datë e pavlefshme."),
        days: z.coerce.number().int().min(1).max(14).default(7),
      }),
      req.query,
    );
    const now = ctx.now();
    const service = await activeService(ctx.db, clinic.id, query.serviceId);
    const dentistIds = query.dentistId
      ? [(await bookableDentist(ctx.db, clinic.id, query.dentistId)).id]
      : (await bookableDentists(ctx.db, clinic.id)).map((d) => d.id);
    const last = lastOnlineDate(clinic, now);
    const free = await availability(ctx.db, {
      clinic,
      service,
      dentistIds,
      fromDate: query.from,
      days: query.days,
      notBefore: earliestOnlineStart(clinic, now),
    });
    res.json({
      days: [...free.entries()].map(([date, slots]) => ({
        date,
        // Beyond the booking horizon nothing is offered, whatever the schedule says.
        slots: date > last ? [] : slots.map((s) => s.startsAt),
      })),
    });
  });

  r.post("/clinics/:slug/book", async (req, res) => {
    const clinic = await clinicBySlug(ctx, req.params.slug);
    const input = parse(bookSchema, req.body);
    const now = ctx.now();
    await throttle(addressOf(ctx, req), now);

    // Owner's rule 2, enforced on the server whatever the page showed.
    if (input.startsAt < earliestOnlineStart(clinic, now)) {
      throw new HttpError(400, `Terminet online caktohen të paktën ${clinic.booking_notice_hours} orë përpara. Për termin më të shpejtë telefononi klinikën.`);
    }
    const date = localDate(input.startsAt, clinic.timezone);
    if (date > lastOnlineDate(clinic, now)) throw new HttpError(400, "Kjo datë është shumë larg për t'u rezervuar online.");

    const service = await activeService(ctx.db, clinic.id, input.serviceId);
    const candidates = input.dentistId
      ? [(await bookableDentist(ctx.db, clinic.id, input.dentistId)).id]
      : (await bookableDentists(ctx.db, clinic.id)).map((d) => d.id);

    // The requested start must be one the schedule really offers (working hours, step, time off).
    const free = await availability(ctx.db, { clinic, service, dentistIds: candidates, fromDate: date, days: 1, notBefore: earliestOnlineStart(clinic, now) });
    const slot = (free.get(date) ?? []).find((s) => s.startsAt.getTime() === input.startsAt.getTime());
    if (!slot) throw new SlotTakenError();

    const endsAt = new Date(input.startsAt.getTime() + service.duration_minutes * 60000);
    const token = newToken();
    const phone = normalizePhone(input.phone);

    // "Any dentist": try the free ones in turn. Two patients racing for the last dentist cannot both win,
    // because the database refuses the second row; that patient is then tried on the next dentist.
    let appointmentId: number | null = null;
    for (const dentistId of slot.dentistIds) {
      try {
        appointmentId = await ctx.db.tx(async (q) => {
          // Counted under a lock on this person, inside the transaction that books: requests sent at the
          // same moment cannot each see "still under the limit".
          await lockPatientEmail(q, clinic.id, input.email);
          const open = await q.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM appointments a JOIN patients p ON p.id = a.patient_id
              WHERE a.clinic_id = $1 AND a.status = 'booked' AND a.starts_at > $2 AND lower(p.email) = $3`,
            [clinic.id, now, input.email],
          );
          if (open[0]!.n >= MAX_OPEN_PER_EMAIL) {
            throw new HttpError(409, "Keni tashmë disa termine të hapura në këtë klinikë. Për më shumë, ju lutemi telefononi klinikën.");
          }
          const existing = await q.query<{ id: number }>(
            "SELECT id FROM patients WHERE clinic_id = $1 AND lower(email) = $2 AND phone = $3 ORDER BY id LIMIT 1",
            [clinic.id, input.email, phone],
          );
          let patientId = existing[0]?.id;
          if (!patientId) {
            const created = await q.query<{ id: number }>(
              "INSERT INTO patients (clinic_id, dentist_id, full_name, phone, email, source) VALUES ($1, $2, $3, $4, $5, 'online') RETURNING id",
              [clinic.id, dentistId, input.fullName, phone, input.email],
            );
            patientId = created[0]!.id;
          }
          return insertAppointment(q, {
            clinicId: clinic.id,
            dentistId,
            patientId,
            serviceId: service.id,
            startsAt: input.startsAt,
            endsAt,
            source: "online",
            noticeAcceptedAt: now,
            tokenHash: hashToken(token),
            createdBy: null,
          });
        });
        break;
      } catch (err) {
        if (!(err instanceof SlotTakenError)) throw err;
      }
    }
    if (appointmentId === null) throw new SlotTakenError();

    await audit(ctx.db, { clinicId: clinic.id, userId: null, action: "appointment_booked_online", entity: "appointment", entityId: appointmentId });
    const emailStatus = await notifyBooked(ctx, appointmentId, token);
    res.status(201).json({ token, startsAt: input.startsAt, emailStatus });
  });

  // ---- the patient's private link -------------------------------------------------------------------
  interface TokenRow {
    id: number;
    clinic_id: number;
    status: string;
    starts_at: Date;
    clinic_name: string;
    clinic_phone: string | null;
    timezone: string;
    dentist_name: string;
    service_name: string;
    patient_name: string;
  }

  // The token travels in a header, never in the address: a host's request log records addresses, and
  // whoever can read that log must not thereby hold every patient's link.
  const TOKEN_HEADER = "x-appointment-token";

  async function byToken(token: string | undefined): Promise<TokenRow> {
    if (!token) throw new HttpError(404, "Ky link nuk është më i vlefshëm.");
    const rows = await ctx.db.query<TokenRow>(
      `SELECT a.id, a.clinic_id, a.status, a.starts_at, c.name AS clinic_name, c.phone AS clinic_phone, c.timezone,
              u.full_name AS dentist_name, s.name AS service_name, p.full_name AS patient_name
         FROM appointments a
         JOIN clinics c ON c.id = a.clinic_id
         JOIN users u ON u.id = a.dentist_id
         JOIN services s ON s.id = a.service_id
         JOIN patients p ON p.id = a.patient_id
        WHERE a.token_hash = $1`,
      [hashToken(token)],
    );
    const row = rows[0];
    // The link stops working once the appointment has started; a cancelled one has no token at all.
    if (!row || new Date(row.starts_at) <= ctx.now()) throw new HttpError(404, "Ky link nuk është më i vlefshëm.");
    return row;
  }

  r.get("/appointment", async (req, res) => {
    const a = await byToken(req.get(TOKEN_HEADER));
    res.json({
      appointment: {
        clinicName: a.clinic_name,
        clinicPhone: a.clinic_phone,
        dentistName: a.dentist_name,
        serviceName: a.service_name,
        patientName: a.patient_name,
        startsAt: a.starts_at,
        when: formatAlbanian(new Date(a.starts_at), a.timezone),
        status: a.status,
      },
    });
  });

  r.post("/appointment/cancel", async (req, res) => {
    const a = await byToken(req.get(TOKEN_HEADER));
    const now = ctx.now();
    const updated = await ctx.db.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = $2, cancelled_by = 'patient', token_hash = NULL
        WHERE id = $1 AND status = 'booked' RETURNING id`,
      [a.id, now],
    );
    if (!updated.length) throw new HttpError(409, "Ky termin nuk mund të anulohet më.");
    await audit(ctx.db, { clinicId: a.clinic_id, userId: null, action: "appointment_cancelled_by_patient", entity: "appointment", entityId: a.id });
    await notifyCancelledByPatient(ctx, a.id);
    res.json({ ok: true });
  });

  return r;
}
