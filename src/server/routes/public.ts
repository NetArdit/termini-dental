import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { hashToken } from "../auth";
import {
  DEPOSIT_CURRENCY,
  DEPOSIT_MINOR,
  SlotTakenError,
  activeService,
  availability,
  bookableDentist,
  bookableDentists,
  earliestOnlineStart,
  insertAppointment,
  lastOnlineDate,
  lockBookingKey,
  lockPatientEmail,
  normalizePhone,
} from "../booking";
import { addressOf, audit, type ClinicRow, type Ctx } from "../context";
import { HttpError, parse } from "../errors";
import { attemptDelivery } from "../mail";
import { handOver, queueBookingConfirmation, queueCancellation } from "../notify";
import { formatAlbanian, isIsoDate, localDate } from "../time";

// Everything a patient can reach without an account. Nothing here reveals whether a person is already a
// patient of the clinic, and nothing identifies a patient except to the holder of their private link.

const bookSchema = z.object({
  /**
   * Made by the page, once per attempt to book, and sent again with every retry of that attempt: a random
   * UUID (version 4). It is what makes "sent twice" one booking, and the patient's private link is worked
   * out from it, so it must be as hard to guess as the link itself.
   */
  idempotencyKey: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Kërkesa nuk është e plotë. Rifreskoni faqen dhe provoni përsëri."),
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
  /**
   * The deposit step of the booking page was gone through. Today it is a demonstration: the one word says
   * so, and it is ALL that a booking may say about a payment. The schema is strict: a request that carries
   * anything else (a card number, a date, a code, a name on a card, under any field name) is refused whole,
   * so card data that should never have left the browser is never read, stored or logged here.
   */
  deposit: z.literal("demo", { message: "Hapi i depozitës nuk është kryer. Rifreskoni faqen dhe provoni përsëri." }),
}).strict();

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** How a key is kept in the database: not the key itself. */
const keyHashOf = (key: string) => sha(`termini-booking-key|${key.toLowerCase()}`);
/**
 * The patient's private link for the booking made with this key. Worked out, not drawn at random, so that a
 * second try of the same booking gets the same link without the link ever being stored anywhere readable:
 * the database holds only the hash of this value, and a different hash of the key.
 */
const tokenOf = (key: string) => createHash("sha256").update(`termini-booking-link|${key.toLowerCase()}`).digest("base64url");
/** What was asked for, as one value: the same key may come back only with the same content. */
const requestHashOf = (input: { serviceId: number; dentistId: number | null; startsAt: Date; fullName: string; phone: string; email: string }) =>
  sha(JSON.stringify([input.serviceId, input.dentistId, input.startsAt.toISOString(), input.fullName, normalizePhone(input.phone), input.email]));
/** How long a page may still be retrying. After it the row is of no use. */
const BOOKING_REQUEST_KEEP_MS = 24 * 60 * 60 * 1000;

interface BookingRequestRow {
  id: number;
  request_hash: string;
  appointment_id: number;
  starts_at: Date;
  status: string;
}

/** A person may hold at most this many future appointments in one clinic through online booking. */
const MAX_OPEN_PER_EMAIL = 3;
const BOOKING_WINDOW_MS = 60 * 60 * 1000;

/** The clinic. There is one (migration 006); before it has been set up there is none, and nothing can be booked. */
async function theClinic(ctx: Ctx): Promise<ClinicRow> {
  const rows = await ctx.db.query<ClinicRow>("SELECT * FROM clinics LIMIT 1");
  if (!rows[0]) throw new HttpError(503, "Klinika nuk është hapur ende për termine online.");
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
  r.get("/clinic", async (_req, res) => {
    const clinic = await theClinic(ctx);
    const [services, dentists] = await Promise.all([
      ctx.db.query<{ id: number; name: string; duration_minutes: number; price_from_minor: number | null }>(
        "SELECT id, name, duration_minutes, price_from_minor FROM services WHERE clinic_id = $1 AND is_active ORDER BY name",
        [clinic.id],
      ),
      bookableDentists(ctx.db, clinic.id),
    ]);
    const ratings = await ctx.db.query<{ dentist_id: number; average: number; count: number }>(
      "SELECT dentist_id, round(avg(rating)::numeric, 1)::float8 AS average, count(*)::int AS count FROM dentist_reviews WHERE clinic_id = $1 AND status = 'published' GROUP BY dentist_id",
      [clinic.id],
    );
    const reviews = await ctx.db.query<{ rating: number; comment: string; dentist_name: string; created_at: Date }>(
      `SELECT v.rating, v.comment, u.full_name AS dentist_name, v.created_at FROM dentist_reviews v JOIN users u ON u.id = v.dentist_id
        WHERE v.clinic_id = $1 AND v.status = 'published' AND v.comment IS NOT NULL AND u.is_active ORDER BY v.created_at DESC LIMIT 6`,
      [clinic.id],
    );
    // When the clinic is open: from the earliest start to the latest end of the dentists who take patients,
    // day by day. It is their own working hours put together, so it cannot say something they do not work.
    const hours = await ctx.db.query<{ weekday: number; start_minute: number; end_minute: number }>(
      `SELECT w.weekday, min(w.start_minute)::int AS start_minute, max(w.end_minute)::int AS end_minute
         FROM working_hours w JOIN users u ON u.id = w.user_id
        WHERE u.clinic_id = $1 AND u.is_active AND u.is_bookable
        GROUP BY w.weekday ORDER BY w.weekday`,
      [clinic.id],
    );
    const now = ctx.now();
    res.json({
      clinic: {
        name: clinic.name,
        phone: clinic.phone,
        address: clinic.address,
        timezone: clinic.timezone,
        bookingNoticeHours: clinic.booking_notice_hours,
        cancelNoticeHours: clinic.cancel_notice_hours,
        // What an online booking asks for, and that today it is a demonstration: nothing is charged.
        deposit: { mode: "demo", amountMinor: DEPOSIT_MINOR, currency: DEPOSIT_CURRENCY },
      },
      services: services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes, priceFromMinor: s.price_from_minor })),
      hours: hours.map((h) => ({ weekday: h.weekday, startMinute: h.start_minute, endMinute: h.end_minute })),
      // Only what the administrator has published, and never a patient's name.
      reviews: reviews.map((v) => ({ rating: v.rating, comment: v.comment, dentistName: v.dentist_name, at: v.created_at })),
      dentists: dentists.map((d) => {
        const r = ratings.find((x) => x.dentist_id === d.id);
        return { id: d.id, fullName: d.full_name, title: d.title, hasPhoto: d.has_photo, rating: r ? { average: r.average, count: r.count } : null };
      }),
      firstDate: localDate(earliestOnlineStart(clinic, now), clinic.timezone),
      lastDate: lastOnlineDate(clinic, now),
    });
  });

  // A dentist's portrait: only for staff who are active and take bookings.
  r.get("/dentists/:id/photo", async (req, res) => {
    const clinic = await theClinic(ctx);
    const id = Number(req.params.id);
    const rows = Number.isInteger(id)
      ? await ctx.db.query<{ photo_type: string; photo_base64: string }>(
          "SELECT photo_type, photo_base64 FROM users WHERE id = $1 AND clinic_id = $2 AND is_active AND is_bookable AND photo_base64 IS NOT NULL",
          [id, clinic.id],
        )
      : [];
    if (!rows[0]) throw new HttpError(404, "Fotografia nuk u gjet.");
    res.set("Cache-Control", "public, max-age=300");
    res.type(rows[0].photo_type).send(Buffer.from(rows[0].photo_base64, "base64"));
  });

  // Free start times for up to 14 consecutive days.
  r.get("/clinic/slots", async (req, res) => {
    const clinic = await theClinic(ctx);
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

  const findRequest = async (q: { query: Ctx["db"]["query"] }, clinicId: number, keyHash: string) =>
    (
      await q.query<BookingRequestRow>(
        `SELECT r.id, r.request_hash, r.appointment_id, a.starts_at, a.status
           FROM booking_requests r JOIN appointments a ON a.id = r.appointment_id
          WHERE r.clinic_id = $1 AND r.key_hash = $2`,
        [clinicId, keyHash],
      )
    )[0];

  /** Thrown inside the booking transaction when another try with the same key got there first. */
  class AlreadyBooked extends Error {
    constructor(public row: BookingRequestRow) {
      super("already booked");
    }
  }

  r.post("/book", async (req, res) => {
    const clinic = await theClinic(ctx);
    const input = parse(bookSchema, req.body);
    const now = ctx.now();
    const keyHash = keyHashOf(input.idempotencyKey);
    const requestHash = requestHashOf(input);
    const token = tokenOf(input.idempotencyKey);

    // The confirmation was written down in the transaction that booked. Here it is handed to the mail server:
    // once, by whoever gets there first (attemptDelivery lets nobody else in meanwhile), and never again
    // once the server has accepted it. A failure is reported as such, never as a failed booking; what did
    // not get through is tried again by the housekeeping that already retries stored messages.
    const confirmationStatus = async (appointmentId: number): Promise<string> => {
      const mail = (await ctx.db.query<{ id: number; status: string }>("SELECT id, status FROM email_log WHERE appointment_id = $1 AND kind = 'booking_confirmation' ORDER BY id LIMIT 1", [appointmentId]))[0];
      if (!mail) return "no_email";
      if (mail.status === "accepted" || !ctx.mailer) return mail.status;
      return (await attemptDelivery(ctx.db, ctx.mailer, mail.id, ctx.now(), token)) ?? (await ctx.db.query<{ status: string }>("SELECT status FROM email_log WHERE id = $1", [mail.id]))[0]!.status;
    };

    // The answer to a booking that was already made with this key: the same appointment, the same link.
    const replay = async (row: BookingRequestRow) => {
      if (row.request_hash !== requestHash) {
        throw new HttpError(409, "Kjo kërkesë është përdorur tashmë për një rezervim tjetër. Rifreskoni faqen dhe provoni përsëri.");
      }
      // Cancelled meanwhile: its link is dead, and saying "booked" would be untrue.
      if (row.status === "cancelled") {
        throw new HttpError(409, "Ky termin është anuluar ndërkohë. Zgjidhni përsëri orarin për të caktuar një termin të ri.");
      }
      const emailStatus = await confirmationStatus(row.appointment_id);
      res.setHeader("Idempotent-Replay", "true");
      res.status(201).json({ token, startsAt: row.starts_at, emailStatus });
    };

    // A row is of use only while a page may still be retrying. Removed before the lookup, so that "a day" is
    // true whatever else happened meanwhile: a try that comes later than that is a new attempt.
    await ctx.db.query("DELETE FROM booking_requests WHERE created_at < $1", [new Date(now.getTime() - BOOKING_REQUEST_KEEP_MS)]);

    // Looked up before anything else: a second try must not be told "this time was just taken" by the very
    // appointment the first try made, nor be counted as one more booking from this address.
    const before = await findRequest(ctx.db, clinic.id, keyHash);
    if (before) return replay(before);

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
    const phone = normalizePhone(input.phone);

    // "Any dentist": try the free ones in turn. Two patients racing for the last dentist cannot both win,
    // because the database refuses the second row; that patient is then tried on the next dentist.
    let appointmentId: number | null = null;
    for (const dentistId of slot.dentistIds) {
      try {
        appointmentId = await ctx.db.tx(async (q) => {
          // Two tries of the same booking at the same moment: one waits here, then finds the other's row.
          await lockBookingKey(q, clinic.id, keyHash);
          const done = await findRequest(q, clinic.id, keyHash);
          if (done) throw new AlreadyBooked(done);
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
          const id = await insertAppointment(q, {
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
            deposit: { mode: "demo", amountMinor: DEPOSIT_MINOR, currency: DEPOSIT_CURRENCY },
          });
          // In the same transaction as the appointment, so that all of them exist or none does: the record
          // of this request, the line in the audit log, and the confirmation waiting to be sent.
          await q.query("INSERT INTO booking_requests (clinic_id, key_hash, request_hash, appointment_id, created_at) VALUES ($1, $2, $3, $4, $5)", [clinic.id, keyHash, requestHash, id, now]);
          await audit(q, { clinicId: clinic.id, userId: null, action: "appointment_booked_online", entity: "appointment", entityId: id });
          await queueBookingConfirmation(ctx, q, id, token);
          return id;
        });
        break;
      } catch (err) {
        if (err instanceof AlreadyBooked) return replay(err.row);
        if (!(err instanceof SlotTakenError)) throw err;
      }
    }
    if (appointmentId === null) throw new SlotTakenError();

    const emailStatus = await confirmationStatus(appointmentId);
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
    dentist_id: number;
    deposit_mode: string | null;
    deposit_amount_minor: number | null;
    deposit_currency: string | null;
  }

  // The token travels in a header, never in the address: a host's request log records addresses, and
  // whoever can read that log must not thereby hold every patient's link.
  const TOKEN_HEADER = "x-appointment-token";

  /** How long after a visit that took place its link still opens it, so that the patient can review it. */
  const REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

  async function byToken(token: string | undefined, afterVisit = false): Promise<TokenRow> {
    if (!token) throw new HttpError(404, "Ky link nuk është më i vlefshëm.");
    const rows = await ctx.db.query<TokenRow>(
      `SELECT a.id, a.clinic_id, a.dentist_id, a.status, a.starts_at, a.deposit_mode, a.deposit_amount_minor, a.deposit_currency, c.name AS clinic_name, c.phone AS clinic_phone, c.timezone,
              u.full_name AS dentist_name, s.name AS service_name, p.full_name AS patient_name
         FROM appointments a
         JOIN clinics c ON c.id = a.clinic_id
         JOIN users u ON u.id = a.dentist_id
         JOIN services s ON s.id = a.service_id
         JOIN patients p ON p.id = a.patient_id
        WHERE a.token_hash = $1 OR a.mail_token_hashes @> ARRAY[$1]::text[]`,
      [hashToken(token)],
    );
    const row = rows[0];
    // The link stops working once the appointment has started; a cancelled one has no token at all.
    // One exception, for where the caller asks for it: a visit that took place (it has its report) can be
    // opened for thirty days more, which is how the patient reviews it. A missed or unmarked one cannot.
    const started = row ? ctx.now().getTime() - new Date(row.starts_at).getTime() : 0;
    const visited = afterVisit && row?.status === "completed" && started <= REVIEW_WINDOW_MS;
    if (!row || (started >= 0 && !visited)) throw new HttpError(404, "Ky link nuk është më i vlefshëm.");
    return row;
  }

  r.get("/appointment", async (req, res) => {
    const a = await byToken(req.get(TOKEN_HEADER), true);
    const review = (await ctx.db.query<{ rating: number; comment: string | null }>("SELECT rating, comment FROM dentist_reviews WHERE appointment_id = $1", [a.id]))[0];
    // Before the visit the link is how the patient reads and cancels their appointment. After it, the link
    // is kept alive only so that the visit can be reviewed: it then says which visit and with whom, and no
    // longer the patient's name or what was paid. A link that lingers in a mailbox for a month tells less.
    const past = new Date(a.starts_at).getTime() <= ctx.now().getTime();
    res.json({
      // A visit that took place can be reviewed, once.
      review: review ? { rating: review.rating, comment: review.comment } : null,
      canReview: a.status === "completed" && !review,
      appointment: {
        clinicName: a.clinic_name,
        clinicPhone: a.clinic_phone,
        dentistName: a.dentist_name,
        serviceName: a.service_name,
        patientName: past ? null : a.patient_name,
        startsAt: a.starts_at,
        when: formatAlbanian(new Date(a.starts_at), a.timezone),
        status: a.status,
        deposit: a.deposit_mode && !past ? { mode: a.deposit_mode, amountMinor: a.deposit_amount_minor, currency: a.deposit_currency } : null,
      },
    });
  });

  // The patient's review of the dentist who treated them: through their own link, after the visit, once.
  // It is shown to the public only after the administrator has read it.
  r.post("/appointment/review", async (req, res) => {
    const a = await byToken(req.get(TOKEN_HEADER), true);
    const input = parse(
      z
        .object({
          rating: z.number().int().min(1, "Zgjidhni nga 1 deri në 5 yje.").max(5, "Zgjidhni nga 1 deri në 5 yje."),
          comment: z.string().trim().max(600, "Komenti mund të ketë deri në 600 shkronja.").nullable().default(null),
        })
        .strict(),
      req.body,
    );
    if (a.status !== "completed") throw new HttpError(409, "Vlerësimi shkruhet pas vizitës.");
    const made = await ctx.db.tx(async (q) => {
      const rows = await q.query<{ id: number }>(
        "INSERT INTO dentist_reviews (clinic_id, appointment_id, dentist_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (appointment_id) DO NOTHING RETURNING id",
        [a.clinic_id, a.id, a.dentist_id, input.rating, input.comment || null, ctx.now()],
      );
      if (rows[0]) await audit(q, { clinicId: a.clinic_id, userId: null, action: "review_submitted", entity: "appointment", entityId: a.id, meta: { rating: input.rating } });
      return rows[0];
    });
    if (!made) throw new HttpError(409, "Për këtë vizitë keni dhënë tashmë një vlerësim.");
    res.status(201).json({ ok: true });
  });

  r.post("/appointment/cancel", async (req, res) => {
    const a = await byToken(req.get(TOKEN_HEADER));
    const now = ctx.now();
    // One transaction: cancelled, every link dead, on record in the audit log, and the message about it
    // written down. Sent only after that is committed.
    const emailId = await ctx.db.tx(async (q) => {
      const updated = await q.query(
        `UPDATE appointments SET status = 'cancelled', cancelled_at = $2, cancelled_by = 'patient', token_hash = NULL, mail_token_hashes = '{}'
          WHERE id = $1 AND status = 'booked' RETURNING id`,
        [a.id, now],
      );
      if (!updated.length) throw new HttpError(409, "Ky termin nuk mund të anulohet më.");
      await audit(q, { clinicId: a.clinic_id, userId: null, action: "appointment_cancelled_by_patient", entity: "appointment", entityId: a.id });
      return queueCancellation(ctx, q, a.id, "patient");
    });
    await handOver(ctx, emailId);
    res.json({ ok: true });
  });

  return r;
}
