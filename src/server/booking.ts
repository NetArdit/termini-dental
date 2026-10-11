import { DateTime } from "luxon";
import type { ClinicRow } from "./context";
import { EXCLUSION_VIOLATION, pgErrorCode, type Queryer } from "./db";
import { HttpError } from "./errors";
import { HOUR_MS, dayBounds, freeSlots, type Interval, type WeeklyHours } from "./time";

// The scheduling core shared by the public booking page and the staff calendar: what is free, and the one
// place an appointment row is inserted.

export interface ServiceRow {
  id: number;
  name: string;
  duration_minutes: number;
}

export interface DentistRow {
  id: number;
  full_name: string;
}

export async function activeService(q: Queryer, clinicId: number, serviceId: number): Promise<ServiceRow> {
  const rows = await q.query<ServiceRow>("SELECT id, name, duration_minutes FROM services WHERE id = $1 AND clinic_id = $2 AND is_active", [serviceId, clinicId]);
  if (!rows[0]) throw new HttpError(400, "Ky shërbim nuk ofrohet.", { serviceId: "I pavlefshëm" });
  return rows[0];
}

/** Dentists of the clinic that patients can be booked with. */
export async function bookableDentists(q: Queryer, clinicId: number): Promise<DentistRow[]> {
  return q.query<DentistRow>("SELECT id, full_name FROM users WHERE clinic_id = $1 AND is_active AND is_bookable ORDER BY full_name", [clinicId]);
}

export async function bookableDentist(q: Queryer, clinicId: number, dentistId: number): Promise<DentistRow> {
  const rows = await q.query<DentistRow>("SELECT id, full_name FROM users WHERE id = $1 AND clinic_id = $2 AND is_active AND is_bookable", [dentistId, clinicId]);
  if (!rows[0]) throw new HttpError(400, "Ky stomatolog nuk pranon termine.", { dentistId: "I pavlefshëm" });
  return rows[0];
}

export async function hoursOf(q: Queryer, dentistIds: number[]): Promise<Map<number, WeeklyHours[]>> {
  const out = new Map<number, WeeklyHours[]>(dentistIds.map((id) => [id, []]));
  if (!dentistIds.length) return out;
  const rows = await q.query<WeeklyHours & { user_id: number }>(
    "SELECT user_id, weekday, start_minute, end_minute FROM working_hours WHERE user_id = ANY($1::int[])",
    [dentistIds],
  );
  for (const row of rows) out.get(row.user_id)?.push(row);
  return out;
}

/** Live appointments and time off of the given dentists that touch [from, to). */
export async function busyOf(q: Queryer, dentistIds: number[], from: Date, to: Date): Promise<Map<number, Interval[]>> {
  const out = new Map<number, Interval[]>(dentistIds.map((id) => [id, []]));
  if (!dentistIds.length) return out;
  const rows = await q.query<{ dentist_id: number; starts_at: Date; ends_at: Date }>(
    `SELECT dentist_id, starts_at, ends_at FROM appointments
      WHERE dentist_id = ANY($1::int[]) AND status <> 'cancelled' AND starts_at < $3 AND ends_at > $2
     UNION ALL
     SELECT user_id, starts_at, ends_at FROM time_off
      WHERE user_id = ANY($1::int[]) AND starts_at < $3 AND ends_at > $2`,
    [dentistIds, from, to],
  );
  for (const row of rows) out.get(row.dentist_id)?.push({ start: new Date(row.starts_at), end: new Date(row.ends_at) });
  return out;
}

/** Earliest instant a patient may book online right now (owner's rule 2: 36 hours by default). */
export function earliestOnlineStart(clinic: ClinicRow, now: Date): Date {
  return new Date(now.getTime() + clinic.booking_notice_hours * HOUR_MS);
}

/** Last local date patients may book online. */
export function lastOnlineDate(clinic: ClinicRow, now: Date): string {
  return DateTime.fromJSDate(now, { zone: clinic.timezone }).plus({ days: clinic.booking_horizon_days }).toISODate() ?? "";
}

/**
 * Free start times per local date for one service, over `days` consecutive dates starting at `fromDate`.
 * Each start lists the dentists who are free then, so "any dentist" bookings know whom to try.
 */
export async function availability(
  q: Queryer,
  opts: { clinic: ClinicRow; service: ServiceRow; dentistIds: number[]; fromDate: string; days: number; notBefore: Date },
): Promise<Map<string, Array<{ startsAt: Date; dentistIds: number[] }>>> {
  const zone = opts.clinic.timezone;
  const first = DateTime.fromISO(opts.fromDate, { zone });
  const dates = Array.from({ length: opts.days }, (_, i) => first.plus({ days: i }).toISODate() ?? "");
  const range = { start: dayBounds(dates[0]!, zone).start, end: dayBounds(dates[dates.length - 1]!, zone).end };
  const [hours, busy] = await Promise.all([hoursOf(q, opts.dentistIds), busyOf(q, opts.dentistIds, range.start, range.end)]);

  const out = new Map<string, Array<{ startsAt: Date; dentistIds: number[] }>>();
  for (const date of dates) {
    const byStart = new Map<number, number[]>();
    for (const dentistId of opts.dentistIds) {
      const starts = freeSlots({
        date,
        zone,
        hours: hours.get(dentistId) ?? [],
        durationMinutes: opts.service.duration_minutes,
        stepMinutes: opts.clinic.slot_step_minutes,
        busy: busy.get(dentistId) ?? [],
        notBefore: opts.notBefore,
      });
      for (const start of starts) {
        const key = start.getTime();
        byStart.set(key, [...(byStart.get(key) ?? []), dentistId]);
      }
    }
    out.set(
      date,
      [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([ms, dentistIds]) => ({ startsAt: new Date(ms), dentistIds })),
    );
  }
  return out;
}

export interface NewAppointment {
  clinicId: number;
  dentistId: number;
  patientId: number;
  serviceId: number;
  startsAt: Date;
  endsAt: Date;
  source: "online" | "local";
  noticeAcceptedAt: Date | null;
  tokenHash: string | null;
  createdBy: number | null;
}

/** Thrown when the database refused the row because the dentist already has an appointment then. */
export class SlotTakenError extends HttpError {
  constructor(message = "Ky orar sapo u zu. Ju lutemi zgjidhni një orar tjetër.") {
    super(409, message);
  }
}

// Transaction-scoped advisory locks (released at commit or rollback). The first number is the kind of thing
// locked. Order when both are taken: email first, then dentist.
const LOCK_DENTIST = 1;
const LOCK_EMAIL = 2;

/** Makes everything that changes one dentist's calendar wait its turn. */
export async function lockDentist(q: Queryer, dentistId: number) {
  await q.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [LOCK_DENTIST, dentistId]);
}

/** Makes online bookings of one person in one clinic wait their turn, so a limit on them cannot be raced. */
export async function lockPatientEmail(q: Queryer, clinicId: number, email: string) {
  await q.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [LOCK_EMAIL, `${clinicId}:${email}`]);
}

/**
 * Inserts one appointment. The database's exclusion constraint is the only judge of whether the time is
 * free; this function just turns its refusal into a message a person can act on.
 * Call it as the last statement of its transaction: a refused insert aborts the transaction.
 */
export async function insertAppointment(q: Queryer, a: NewAppointment): Promise<number> {
  // Time off is not covered by the exclusion constraint, so it is checked here under the dentist's lock:
  // a booking and a new time-off period for the same dentist can never both go through.
  await lockDentist(q, a.dentistId);
  const off = await q.query("SELECT 1 FROM time_off WHERE user_id = $1 AND starts_at < $3 AND ends_at > $2 LIMIT 1", [a.dentistId, a.startsAt, a.endsAt]);
  if (off.length) throw new SlotTakenError("Stomatologu nuk punon në këtë kohë. Ju lutemi zgjidhni një orar tjetër.");
  try {
    const rows = await q.query<{ id: number }>(
      `INSERT INTO appointments (clinic_id, dentist_id, patient_id, service_id, starts_at, ends_at, source, notice_accepted_at, token_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [a.clinicId, a.dentistId, a.patientId, a.serviceId, a.startsAt, a.endsAt, a.source, a.noticeAcceptedAt, a.tokenHash, a.createdBy],
    );
    return rows[0]!.id;
  } catch (err) {
    if (pgErrorCode(err) === EXCLUSION_VIOLATION) throw new SlotTakenError();
    throw err;
  }
}

/** Phone numbers compared without spaces, dashes or brackets. */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}
