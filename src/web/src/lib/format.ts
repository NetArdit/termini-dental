// Dates and times as people in Kosovo read them. Everything is shown in the clinic's timezone, whatever the
// timezone of the device, so a dentist travelling abroad still sees the clinic's day.

export const DEFAULT_ZONE = "Europe/Belgrade";

export const WEEKDAYS = ["E hënë", "E martë", "E mërkurë", "E enjte", "E premte", "E shtunë", "E diel"];
const WEEKDAYS_SHORT = ["Hën", "Mar", "Mër", "Enj", "Pre", "Sht", "Die"];
const MONTHS = ["janar", "shkurt", "mars", "prill", "maj", "qershor", "korrik", "gusht", "shtator", "tetor", "nëntor", "dhjetor"];

function parts(instant: Date, zone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** "09:30" */
export function fmtTime(iso: string | Date, zone = DEFAULT_ZONE): string {
  return parts(new Date(iso), zone).time;
}

/** The calendar date (YYYY-MM-DD) of an instant in the clinic's zone. */
export function dateOf(iso: string | Date, zone = DEFAULT_ZONE): string {
  return parts(new Date(iso), zone).date;
}

export function today(zone = DEFAULT_ZONE): string {
  return dateOf(new Date(), zone);
}

/** Calendar arithmetic on YYYY-MM-DD, independent of any timezone. */
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday */
function weekdayIndex(date: string): number {
  return (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
}

/** "E premte, 16 tetor 2026" */
export function fmtDateLong(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[weekdayIndex(date)]}, ${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** "16 tetor 2026" */
export function fmtDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Pieces for a compact day button: "Pre", "16", "tet". */
export function dayChip(date: string) {
  const [, m, d] = date.split("-").map(Number);
  return { weekday: WEEKDAYS_SHORT[weekdayIndex(date)]!, day: String(d), month: MONTHS[(m ?? 1) - 1]!.slice(0, 3) };
}

/** "E premte, 16 tetor 2026, ora 10:30" */
export function fmtDateTime(iso: string | Date, zone = DEFAULT_ZONE): string {
  return `${fmtDateLong(dateOf(iso, zone))}, ora ${fmtTime(iso, zone)}`;
}

/** 540 -> "09:00" */
export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "09:00" -> 540 */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** "45 min", "1 orë", "1 orë e 30 min" */
export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} orë e ${m} min` : `${h} orë`;
}

/**
 * The instant at which `time` on `date` happens in `zone`. Browsers cannot build that directly, so the offset
 * of the zone on that day is measured and applied (twice, to land right on days when the clocks change).
 */
export function zonedInstant(date: string, time: string, zone = DEFAULT_ZONE): Date {
  const wanted = new Date(`${date}T${time}:00Z`).getTime();
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), zone);
    const shown = new Date(`${p.date}T${p.time}:00Z`).getTime();
    guess += wanted - shown;
  }
  return new Date(guess);
}
