import type { Ctx } from "./context";
import type { Queryer } from "./db";
import { bookingConfirmationMail, cancelledByClinicMail, cancelledByPatientMail, LINK_TOKEN, attemptDelivery, deliver, queueEmail, reminderMail, type EmailKind, type EmailStatus, type MailFacts, type OutgoingEmail } from "./mail";
import { formatAlbanian } from "./time";

// Patient emails about one appointment. Each returns what happened to the message, or "no_email" when the
// patient has no address on file (possible for local patients) so the caller can tell staff to phone.

export type NotifyResult = EmailStatus | "no_email";

interface Loaded {
  clinicId: number;
  to: string | null;
  facts: MailFacts;
}

async function load(ctx: Ctx, appointmentId: number, token?: string, q: Queryer = ctx.db): Promise<Loaded | null> {
  const rows = await q.query<{
    clinic_id: number;
    clinic_name: string;
    clinic_phone: string | null;
    timezone: string;
    cancel_notice_hours: number;
    patient_name: string;
    patient_email: string | null;
    dentist_name: string;
    service_name: string;
    starts_at: Date;
    cancel_reason: string | null;
  }>(
    `SELECT a.clinic_id, c.name AS clinic_name, c.phone AS clinic_phone, c.timezone, c.cancel_notice_hours,
            p.full_name AS patient_name, p.email AS patient_email, u.full_name AS dentist_name,
            s.name AS service_name, a.starts_at, a.cancel_reason
       FROM appointments a
       JOIN clinics c ON c.id = a.clinic_id
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.dentist_id
       JOIN services s ON s.id = a.service_id
      WHERE a.id = $1`,
    [appointmentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clinicId: row.clinic_id,
    to: row.patient_email,
    facts: {
      clinicName: row.clinic_name,
      clinicPhone: row.clinic_phone,
      patientName: row.patient_name,
      dentistName: row.dentist_name,
      serviceName: row.service_name,
      when: formatAlbanian(new Date(row.starts_at), row.timezone),
      cancelNoticeHours: row.cancel_notice_hours,
      // After "#": a browser keeps that part to itself, so the token reaches no server's request log.
      // What is composed here is what gets stored, so the secret part of the link is never in it: only the
      // place where it goes. It is filled in at the moment of sending (mail.ts, attemptDelivery).
      link: token ? `${ctx.publicUrl}/termin#${LINK_TOKEN}` : undefined,
      reason: row.cancel_reason,
    },
  };
}

async function compose(ctx: Ctx, appointmentId: number, kind: EmailKind, build: (facts: MailFacts) => { subject: string; text: string }, token?: string, q: Queryer = ctx.db): Promise<OutgoingEmail | null> {
  const loaded = await load(ctx, appointmentId, token, q);
  if (!loaded || !loaded.to) return null;
  return { clinicId: loaded.clinicId, appointmentId, to: loaded.to, kind, ...build(loaded.facts) };
}

async function send(ctx: Ctx, appointmentId: number, kind: EmailKind, build: (facts: MailFacts) => { subject: string; text: string }, token?: string): Promise<NotifyResult> {
  const email = await compose(ctx, appointmentId, kind, build, token);
  if (!email) return "no_email";
  return deliver(ctx.db, ctx.mailer, email, ctx.now(), token);
}

/** The reminder for an appointment, ready to be queued, or null when the patient has no address. */
export const composeReminder = (ctx: Ctx, appointmentId: number) => compose(ctx, appointmentId, "reminder", reminderMail);

/**
 * Writes down the message that tells the patient their appointment was cancelled, inside the transaction that
 * cancels it: the cancellation and "the patient must be told" are stored together or not at all. Nothing is
 * sent here. Returns the message's id, or null when the patient has no address (staff then phone).
 */
export async function queueCancellation(ctx: Ctx, q: Queryer, appointmentId: number, by: "clinic" | "patient"): Promise<number | null> {
  const email = by === "clinic" ? await compose(ctx, appointmentId, "cancelled_by_clinic", cancelledByClinicMail, undefined, q) : await compose(ctx, appointmentId, "cancelled_by_patient", cancelledByPatientMail, undefined, q);
  return email ? queueEmail(q, email) : null;
}

/**
 * Hands a message that was written down in a transaction to the mail server, after that transaction has
 * been committed. Never throws for a mail failure: what was committed stands, and what did not get through
 * is still written down for the housekeeping's retries and the staff's "send again".
 */
export async function handOver(ctx: Ctx, emailId: number | null, token?: string): Promise<NotifyResult> {
  if (emailId === null) return "no_email";
  if (!ctx.mailer) return "stored";
  return (await attemptDelivery(ctx.db, ctx.mailer, emailId, ctx.now(), token)) ?? "stored";
}

/**
 * Writes the confirmation of a booking down, inside the transaction that makes the booking: the appointment
 * and the message that tells the patient about it exist together or not at all. Nothing is sent here.
 * Returns the message's id, or null when the patient has no address.
 */
export async function queueBookingConfirmation(ctx: Ctx, q: Queryer, appointmentId: number, token: string): Promise<number | null> {
  const email = await compose(ctx, appointmentId, "booking_confirmation", bookingConfirmationMail, token, q);
  return email ? queueEmail(q, email) : null;
}

export const notifyBooked = (ctx: Ctx, appointmentId: number, token?: string) => send(ctx, appointmentId, "booking_confirmation", bookingConfirmationMail, token);

