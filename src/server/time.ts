import { DateTime } from "luxon";

// Calendar arithmetic. Instants are plain Date objects (UTC inside); anything about "which day" or "what
// time on the wall clock" is computed in the clinic's timezone, so daylight saving is handled by the zone
// rules rather than by a fixed offset.

export interface Interval {
  start: Date;
  end: Date;
}

export interface WeeklyHours {
  weekday: number; // ISO: 1 = Monday ... 7 = Sunday
  start_minute: number;
  end_minute: number;
}

export const HOUR_MS = 60 * 60 * 1000;

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}

/** The instants at which a local calendar day starts and ends in `zone`. */
export function dayBounds(date: string, zone: string): Interval {
  const start = DateTime.fromISO(date, { zone }).startOf("day");
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** The local calendar date (YYYY-MM-DD) of an instant in `zone`. */
export function localDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate() ?? "";
}

/** Minutes after local midnight on `date`, as an instant. */
function atMinute(date: string, minute: number, zone: string): Date {
  const d = DateTime.fromISO(date, { zone });
  return DateTime.fromObject(
    { year: d.year, month: d.month, day: d.day, hour: Math.floor(minute / 60), minute: minute % 60 },
    { zone },
  ).toJSDate();
}

/**
 * Whether [start, end) lies completely inside one of the dentist's working periods on its local day.
 * An appointment may not straddle two periods (for example a lunch break).
 */
export function insideWorkingHours(slot: Interval, hours: WeeklyHours[], zone: string): boolean {
  const start = DateTime.fromJSDate(slot.start, { zone });
  const end = DateTime.fromJSDate(slot.end, { zone });
  const startMinute = start.hour * 60 + start.minute;
  const endMinute = startMinute + Math.round((slot.end.getTime() - slot.start.getTime()) / 60000);
  // Same local day, unless it ends exactly at midnight.
  if (!start.hasSame(end.minus({ milliseconds: 1 }), "day")) return false;
  return hours.some((h) => h.weekday === start.weekday && h.start_minute <= startMinute && endMinute <= h.end_minute);
}

/**
 * Start times a patient or the clinic can pick on one local day for one dentist.
 * `busy` are existing appointments and time off; `notBefore` is the earliest instant allowed to start.
 */
export function freeSlots(opts: {
  date: string;
  zone: string;
  hours: WeeklyHours[];
  durationMinutes: number;
  stepMinutes: number;
  busy: Interval[];
  notBefore: Date;
}): Date[] {
  const weekday = DateTime.fromISO(opts.date, { zone: opts.zone }).weekday;
  const out: Date[] = [];
  for (const period of opts.hours.filter((h) => h.weekday === weekday).sort((a, b) => a.start_minute - b.start_minute)) {
    for (let m = period.start_minute; m + opts.durationMinutes <= period.end_minute; m += opts.stepMinutes) {
      const start = atMinute(opts.date, m, opts.zone);
      const end = new Date(start.getTime() + opts.durationMinutes * 60000);
      if (start < opts.notBefore) continue;
      if (opts.busy.some((b) => overlaps({ start, end }, b))) continue;
      out.push(start);
    }
  }
  return out;
}

/** "e premte, 16 tetor 2026, ora 10:30" — how an appointment time is written in emails and on screen. */
export function formatAlbanian(instant: Date, zone: string): string {
  const d = DateTime.fromJSDate(instant, { zone }).setLocale("sq");
  return `${d.toFormat("cccc, d LLLL yyyy")}, ora ${d.toFormat("HH:mm")}`;
}

/** Calendar arithmetic on YYYY-MM-DD, independent of any timezone. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
