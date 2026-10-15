import { createHash, randomBytes } from "node:crypto";
import type { Queryer } from "./db";

// Email. Every message the system tries to send is written to email_log with its outcome, so the clinic can
// always see whether a patient was really told (owner's rule 3) and phone them when the email failed.

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
  /** How long one send may take before it is given up. Default SEND_TIMEOUT_MS; never more than half a claim. */
  timeoutMs?: number;
}

export type EmailKind = "booking_confirmation" | "cancelled_by_clinic" | "cancelled_by_patient" | "reminder";
/**
 * What is known about a message, and no more than that:
 * - "accepted": the mail server took it. That is where our knowledge ends: it may still bounce or land in
 *   spam, and a provider over its quota may drop it. It is never shown to staff as "the patient was told".
 * - "stored": written down, not handed to any mail server (none configured, or not attempted yet).
 * - "failed": the mail server refused it, or could not be reached.
 */
export type EmailStatus = "accepted" | "stored" | "failed";

/** After this many attempts the system stops retrying by itself; staff can still resend by hand. */
export const MAX_AUTOMATIC_ATTEMPTS = 3;
/**
 * The two durations that together keep a message from being sent twice at once.
 * While an attempt runs it owns the message (email_log.sending_since is set): nobody else (a second
 * click, the retry loop, another server process) may start a send. It gives the message back only when it
 * KNOWS the outcome: the mail server took the message, or refused it.
 * An attempt stops waiting after SEND_TIMEOUT_MS. Stopping to wait does not stop the send: the message may
 * still be on its way. So after a timeout the outcome is unknown and the claim is kept. The same holds for
 * a process that died in the middle of a send. A kept claim lapses CLAIM_MS after the attempt began, so
 * that the message can be picked up again. By then the earlier send is over in every ordinary case: the
 * connection is dropped when the mail server stays silent for 45 seconds (see smtpMailer). Those are
 * limits on silence, though, not on the whole exchange. A server that kept answering, slowly, for more than
 * five minutes would still be mid-send when the claim lapses. Nothing here puts an end to such a send.
 */
export const SEND_TIMEOUT_MS = 60 * 1000;
export const CLAIM_MS = 5 * 60 * 1000;
/** Retries that the system makes by itself are at least this far apart for one message. */
const RETRY_SPACING_MS = 5 * 60 * 1000;

/** A mailer that talks to the SMTP server of the checked configuration (see config.ts). */
export async function smtpMailer(smtp: { host: string; port: number; user: string | null; pass: string | null; from: string }): Promise<Mailer> {
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    // A mail server that goes silent must not hold a message for ever. These are limits on silence (no
    // connection, no greeting, no data for that long), not on how long a whole send may take.
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 45_000,
  });
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from: smtp.from, to, subject, text });
    },
  };
}

/**
 * What stands in a stored message where the patient's private link has its secret part. The secret is put in
 * only when the message is handed to the mail server, and is never written down (see attemptDelivery).
 */
export const LINK_TOKEN = "{{token}}";
/** A stored message as staff may see it: they are told there is a link, never shown where it would go. */
export const withoutLink = (text: string) => text.replace(/\S*\{\{token\}\}/g, "[linku privat i pacientit]");

export interface OutgoingEmail {
  clinicId: number;
  appointmentId: number | null;
  to: string;
  kind: EmailKind;
  subject: string;
  text: string;
}

/**
 * Writes the message down before anything is sent, and returns its id. From here on it cannot be lost:
 * if the process dies before the attempt, the row is still there, "stored", for the next retry.
 * Can run inside a transaction, so that "this must be sent" commits together with whatever caused it.
 */
export async function queueEmail(q: Queryer, email: OutgoingEmail): Promise<number> {
  const rows = await q.query<{ id: number }>(
    `INSERT INTO email_log (clinic_id, appointment_id, to_email, kind, subject, body, status, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, 'stored', 0) RETURNING id`,
    [email.clinicId, email.appointmentId, email.to, email.kind, email.subject, email.text],
  );
  return rows[0]!.id;
}

/**
 * One attempt to hand a stored or failed message to the mail server. Returns what happened, or null when
 * the message is not there to be sent: already accepted, or another attempt holds it right now.
 * Never throws for a mail failure: that must not undo a booking or a cancellation.
 *
 * What holds:
 * - The claim is a single UPDATE, so two attempts cannot both start.
 * - No new attempt starts while an earlier one is waiting for the mail server, nor for the rest of the
 *   five minutes after one that timed out or died. Two sends of one message therefore overlap only if a
 *   send is still going on five minutes after it began (see the last point).
 * - A message the mail server is known to have taken is never sent again.
 *
 * What does not hold, and cannot:
 * - "Exactly once". When the outcome of an attempt is unknown (it timed out, or the process died after the
 *   mail server took the message and before that was written down), the message stays "failed" or
 *   "stored" and is sent again once the claim has lapsed. If the first send did get through, the patient
 *   receives the notice twice. The alternative is a patient who never receives it.
 * - A send that lasts longer than five minutes. The connection's timeouts end a send when the mail server
 *   goes silent, not when it is merely slow, and a send cannot be called back. Such a send could coincide
 *   with a new attempt. Nothing here rules that out.
 */
export async function attemptDelivery(q: Queryer, mailer: Mailer, emailId: number, now: Date, token?: string): Promise<EmailStatus | null> {
  const claimed = await q.query<{ to_email: string; subject: string; body: string; appointment_id: number | null }>(
    `UPDATE email_log SET attempts = attempts + 1, last_attempt_at = $2, sending_since = $2
      WHERE id = $1 AND status IN ('stored', 'failed') AND (sending_since IS NULL OR sending_since <= $3)
      RETURNING to_email, subject, body, appointment_id`,
    [emailId, now, new Date(now.getTime() - CLAIM_MS)],
  );
  const message = claimed[0];
  if (!message) return null;
  // The private link. Whoever made the booking a moment ago still has it and passes it in. Nobody else
  // does, and it is stored nowhere: a later attempt makes a new link for this message and keeps its hash
  // beside the others', so the link on the patient's screen and the link of every mail all work.
  if (message.body.includes(LINK_TOKEN)) {
    let secret = token;
    if (!secret && message.appointment_id !== null) {
      const fresh = randomBytes(32).toString("base64url");
      // Added to the links this appointment already has, never in place of one: an earlier mail may have
      // arrived. Only while the appointment stands: an attempt that was under way when the appointment was
      // cancelled cannot bring a link back to life.
      const set = await q.query("UPDATE appointments SET mail_token_hashes = array_append(mail_token_hashes, $2) WHERE id = $1 AND status = 'booked' RETURNING id", [
        message.appointment_id,
        createHash("sha256").update(fresh).digest("hex"),
      ]);
      if (set.length) secret = fresh;
    }
    // No appointment left to open (it was cancelled): the sentence goes out without a link that would not work.
    message.body = secret ? message.body.split(LINK_TOKEN).join(secret) : withoutLink(message.body);
  }
  const timeoutMs = Math.min(mailer.timeoutMs ?? SEND_TIMEOUT_MS, CLAIM_MS / 2);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  // Not cancelled by the timeout below: there is no way to call a message back. Its late failure is
  // swallowed here; its late success is the unknown outcome described above.
  const sending = mailer.send({ to: message.to_email, subject: message.subject, text: message.body });
  sending.catch(() => {});
  try {
    await Promise.race([
      sending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`no answer from the mail server within ${Math.round(timeoutMs / 1000)} seconds; whether it took the message is unknown`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 500) : "unknown error";
    // A refusal is an outcome: the message is given back at once. A timeout is not: the claim stays, so
    // nothing new is sent while the first send may still be going through.
    await q.query(`UPDATE email_log SET status = 'failed', error = $2${timedOut ? "" : ", sending_since = NULL"} WHERE id = $1`, [emailId, error]);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
  await q.query("UPDATE email_log SET status = 'accepted', error = NULL, sending_since = NULL WHERE id = $1", [emailId]);
  return "accepted";
}

/** Writes the message down and, when a mail server is configured, tries once to hand it over. */
export async function deliver(q: Queryer, mailer: Mailer | null, email: OutgoingEmail, now: Date, token?: string): Promise<EmailStatus> {
  const id = await queueEmail(q, email);
  if (!mailer) return "stored";
  return (await attemptDelivery(q, mailer, id, now, token)) ?? "stored";
}

/**
 * SQL condition: is it still worth sending this message? Needs the aliases `e` (email_log) and `a`
 * (appointments, left-joined). A cancellation is worth telling until the appointment's time has passed;
 * a confirmation or a reminder only while the appointment still stands. `$now` holds the current instant.
 */
export const stillWorthSending = (now: number) =>
  `(a.id IS NOT NULL AND a.starts_at > $${now} AND (e.kind IN ('cancelled_by_clinic', 'cancelled_by_patient') OR a.status = 'booked'))`;

/**
 * Tries again, by itself, the messages that did not get through: a mail server that was down, a process
 * that died between writing a message down and sending it, a reminder queued while no server was
 * configured. Each message gets MAX_AUTOMATIC_ATTEMPTS attempts in all, the first one included, and never
 * while an earlier attempt still holds its claim.
 * Returns how many attempts were made.
 */
export async function retryPendingEmails(q: Queryer, mailer: Mailer | null, now: Date): Promise<number> {
  if (!mailer) return 0;
  const pending = await q.query<{ id: number }>(
    `SELECT e.id FROM email_log e LEFT JOIN appointments a ON a.id = e.appointment_id
      WHERE e.status IN ('stored', 'failed') AND e.attempts < $2
        AND (e.last_attempt_at IS NULL OR e.last_attempt_at <= $3)
        AND (e.sending_since IS NULL OR e.sending_since <= $4)
        AND ${stillWorthSending(1)}
      ORDER BY e.id LIMIT 50`,
    [now, MAX_AUTOMATIC_ATTEMPTS, new Date(now.getTime() - RETRY_SPACING_MS), new Date(now.getTime() - CLAIM_MS)],
  );
  let attempts = 0;
  for (const row of pending) if ((await attemptDelivery(q, mailer, row.id, now)) !== null) attempts += 1;
  return attempts;
}

// ---------------------------------------------------------------------------------------------------------
// Message texts (Albanian). `when` is already formatted in the clinic's timezone.
// ---------------------------------------------------------------------------------------------------------

export interface MailFacts {
  clinicName: string;
  clinicPhone: string | null;
  patientName: string;
  dentistName: string;
  serviceName: string;
  when: string;
  cancelNoticeHours: number;
  /** Private link where the patient views or cancels the appointment. */
  link?: string;
  reason?: string | null;
}

const contact = (f: MailFacts) => (f.clinicPhone ? `Për çdo pyetje na telefononi në ${f.clinicPhone}.` : "");

export function bookingConfirmationMail(f: MailFacts) {
  return {
    subject: `Termini juaj në ${f.clinicName} u caktua`,
    text: [
      `I/E nderuar ${f.patientName},`,
      "",
      `Termini juaj u caktua:`,
      `  Klinika: ${f.clinicName}`,
      `  Stomatologu: ${f.dentistName}`,
      `  Shërbimi: ${f.serviceName}`,
      `  Koha: ${f.when}`,
      "",
      `Ju lutemi vini re: nëse paraqitet ndonjë pengesë, klinika mund ta anulojë terminin. Në atë rast ju njoftojmë me email, zakonisht të paktën ${f.cancelNoticeHours} orë para terminit; në raste urgjente njoftimi mund të vijë më vonë.`,
      "",
      f.link ? `Për ta parë ose anuluar terminin: ${f.link}` : "",
      contact(f),
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n")
      .trim(),
  };
}

export function cancelledByClinicMail(f: MailFacts) {
  return {
    subject: `Termini juaj në ${f.clinicName} u anulua`,
    text: [
      `I/E nderuar ${f.patientName},`,
      "",
      `Na vjen keq, termini juaj te ${f.dentistName} (${f.serviceName}) më ${f.when} u anulua nga klinika.`,
      f.reason ? `Arsyeja: ${f.reason}` : "",
      "",
      `Ju lutemi caktoni një termin të ri kur t'ju përshtatet.`,
      contact(f),
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n")
      .trim(),
  };
}

export function cancelledByPatientMail(f: MailFacts) {
  return {
    subject: `Anulimi i terminit në ${f.clinicName} u pranua`,
    text: [
      `I/E nderuar ${f.patientName},`,
      "",
      `Termini juaj te ${f.dentistName} (${f.serviceName}) më ${f.when} u anulua me kërkesën tuaj.`,
      "",
      contact(f),
    ]
      .join("\n")
      .trim(),
  };
}

export function reminderMail(f: MailFacts) {
  return {
    subject: `Kujtesë: termini juaj në ${f.clinicName}`,
    text: [
      `I/E nderuar ${f.patientName},`,
      "",
      `Ju kujtojmë terminin tuaj te ${f.dentistName} (${f.serviceName}): ${f.when}.`,
      "",
      f.link ? `Nëse nuk mund të vini, ju lutemi anulojeni këtu: ${f.link}` : "",
      contact(f),
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n")
      .trim(),
  };
}
