import { useEffect, useMemo, useState } from "react";
import { api, type Appointment, type WorkingPeriod } from "../lib/api";
import { dateOf, fmtTime, minutesToTime, timeToMinutes, today } from "../lib/format";
import { Loading } from "../ui";

// The day as a timetable: one column per dentist, an hour always the same height. Appointments are blocks
// as long as they last; hours outside the working day and time off are hatched; free stretches can be
// clicked to book. It shows what the list cannot: where the gaps are.

export interface TimetableDentist {
  id: number;
  fullName: string;
}

interface TimeOff {
  startsAt: string;
  endsAt: string;
}

/**
 * The scale. With a mouse an hour is 60 px and a quarter of an hour can still be offered. On a touch screen
 * the day is drawn half as tall again, so that the usual half-hour appointment and the shortest free stretch
 * offered (half an hour there) are 45 px: large enough for a finger without leaving their place in time.
 */
function scale() {
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  return { px: touch ? 1.5 : 1, minFree: touch ? 30 : 15, minBlock: touch ? 44 : 26 };
}

const STATUS_STYLE: Record<Appointment["status"], string> = {
  booked: "bg-info-bg border-info-fg text-ink",
  completed: "bg-ok-bg border-ok-fg text-ink",
  no_show: "bg-warn-bg border-warn-fg text-ink",
  cancelled: "",
};
const STATUS_WORD: Record<Appointment["status"], string> = { booked: "i caktuar", completed: "i kryer", no_show: "nuk erdhi", cancelled: "i anuluar" };

/** ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. */
const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

interface Span {
  from: number;
  to: number;
}

/** The parts of `whole` that none of `taken` covers. */
function subtract(whole: Span, taken: Span[]): Span[] {
  let rest: Span[] = [whole];
  for (const t of taken) {
    rest = rest.flatMap((r) => {
      if (t.to <= r.from || t.from >= r.to) return [r];
      const out: Span[] = [];
      if (t.from > r.from) out.push({ from: r.from, to: t.from });
      if (t.to < r.to) out.push({ from: t.to, to: r.to });
      return out;
    });
  }
  return rest;
}

export function DayTimetable({
  date,
  zone,
  dentists,
  appointments,
  onOpen,
  onBook,
}: {
  date: string;
  zone: string;
  dentists: TimetableDentist[];
  appointments: Appointment[];
  onOpen: (appointmentId: number) => void;
  /** A free stretch was chosen: book with this dentist, starting at this time ("HH:MM"). */
  onBook: (dentistId: number, time: string) => void;
}) {
  const [hours, setHours] = useState<Record<number, WorkingPeriod[]>>({});
  const [timeOff, setTimeOff] = useState<Record<number, TimeOff[]>>({});
  const [shown, setShown] = useState<number | null>(null);
  const [nowMinute, setNowMinute] = useState(() => timeToMinutes(fmtTime(new Date(), zone)));
  const ids = dentists.map((d) => d.id).join(",");
  const { px: PX, minFree: MIN_FREE, minBlock } = useMemo(scale, []);

  // Working hours and time off of the dentists in view. Hours are per weekday, so they are fetched once.
  useEffect(() => {
    let current = true;
    void Promise.all(
      dentists.map(async (d) => {
        const [h, t] = await Promise.all([api.get<{ hours: WorkingPeriod[] }>(`/api/staff/${d.id}/hours`), api.get<{ timeOff: TimeOff[] }>(`/api/staff/${d.id}/time-off`)]);
        return [d.id, h.hours, t.timeOff] as const;
      }),
    ).then(
      (all) => {
        if (!current) return;
        setHours(Object.fromEntries(all.map(([id, h]) => [id, h])));
        setTimeOff(Object.fromEntries(all.map(([id, , t]) => [id, t])));
      },
      () => current && setHours({}),
    );
    return () => {
      current = false;
    };
    // The list of dentists is compared by its ids: the caller builds a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  // The line for "now" moves by itself.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMinute(timeToMinutes(fmtTime(new Date(), zone))), 60_000);
    return () => window.clearInterval(timer);
  }, [zone]);

  const weekday = weekdayOf(date);
  const isToday = date === today(zone);
  const live = appointments.filter((a) => a.status !== "cancelled");
  const minuteOf = (iso: string) => timeToMinutes(fmtTime(iso, zone));

  const columns = useMemo(
    () =>
      dentists.map((d) => {
        const work: Span[] = (hours[d.id] ?? []).filter((h) => h.weekday === weekday).map((h) => ({ from: h.startMinute, to: h.endMinute }));
        // Time off that touches this day, cut to the day.
        const away: Span[] = (timeOff[d.id] ?? []).flatMap((t) => {
          const [startDay, endDay] = [dateOf(t.startsAt, zone), dateOf(t.endsAt, zone)];
          if (endDay < date || startDay > date) return [];
          return [{ from: startDay < date ? 0 : minuteOf(t.startsAt), to: endDay > date ? 1440 : minuteOf(t.endsAt) }];
        });
        const mine = live.filter((a) => a.dentistId === d.id).map((a) => ({ a, from: minuteOf(a.startsAt), to: Math.max(minuteOf(a.endsAt), minuteOf(a.startsAt) + 5) }));
        return { dentist: d, work, away, mine };
      }),
    // minuteOf depends only on zone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, hours, timeOff, weekday, date, zone, appointments],
  );

  if (dentists.length === 0) return null;
  if (!dentists.every((d) => hours[d.id])) return <Loading />;

  // From the earliest opening to the latest closing of the dentists shown, widened to whole hours and to
  // any appointment that lies outside (a walk-in recorded before opening still has to be visible).
  const edges = columns.flatMap((c) => [...c.work, ...c.mine]);
  const first = edges.length ? Math.min(...edges.map((e) => e.from)) : 9 * 60;
  const last = edges.length ? Math.max(...edges.map((e) => e.to)) : 17 * 60;
  const start = Math.floor(first / 60) * 60;
  const end = Math.max(Math.ceil(last / 60) * 60, start + 60);
  const height = (end - start) * PX;
  const marks = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60);
  const active = shown !== null && dentists.some((d) => d.id === shown) ? shown : dentists[0]!.id;
  const canBook = date >= today(zone);

  return (
    <div>
      {/* On a phone one dentist fits; these choose which. */}
      {dentists.length > 1 ? (
        <div className="mb-3 flex gap-2 md:hidden" role="group" aria-label="Stomatologu i shfaqur">
          {dentists.map((d) => (
            <button
              key={d.id}
              type="button"
              aria-pressed={d.id === active}
              onClick={() => setShown(d.id)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${d.id === active ? "border-brand-700 bg-brand-700 text-white" : "border-line-strong bg-surface text-ink"}`}
            >
              {d.fullName}
            </button>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="flex">
          <div className="w-14 shrink-0 border-r border-line" aria-hidden="true">
            <div className="h-14 border-b border-line" />
            <div className="relative" style={{ height }}>
              {marks.map((m) => (
                <span key={m} className="absolute right-2 -translate-y-1/2 text-xs tabular-nums text-ink-faint first:translate-y-0 last:-translate-y-full" style={{ top: (m - start) * PX }}>
                  {minutesToTime(m)}
                </span>
              ))}
            </div>
          </div>

          {columns.map(({ dentist, work, away, mine }) => {
            const closed = subtract({ from: start, to: end }, work);
            const hatched = [...closed, ...away.map((s) => ({ from: Math.max(s.from, start), to: Math.min(s.to, end) })).filter((s) => s.to > s.from)];
            // Free: working time that is not away, not booked, and (today) not already past.
            const busy = [...away, ...mine.map((m) => ({ from: m.from, to: m.to })), ...(isToday ? [{ from: 0, to: Math.ceil(nowMinute / 15) * 15 }] : [])];
            const free = canBook ? work.flatMap((w) => subtract(w, busy)).filter((s) => s.to - s.from >= MIN_FREE) : [];
            return (
              <section key={dentist.id} aria-label={dentist.fullName} className={`min-w-0 flex-1 border-r border-line last:border-r-0 ${dentist.id === active ? "" : "max-md:hidden"}`}>
                <header className="flex h-14 flex-col justify-center border-b border-line px-3">
                  <h3 className="truncate text-sm font-semibold">{dentist.fullName}</h3>
                  <p className="truncate text-xs text-ink-soft">
                    {mine.length} {mine.length === 1 ? "termin" : "termine"}
                    {work.length ? ` · ${work.map((w) => `${minutesToTime(w.from)}–${minutesToTime(w.to)}`).join(", ")}` : " · nuk punon këtë ditë"}
                  </p>
                </header>
                <div className="relative" style={{ height, backgroundImage: `repeating-linear-gradient(to bottom, var(--color-line) 0 1px, transparent 1px ${60 * PX}px)` }}>
                  {hatched.map((s, i) => (
                    <div
                      key={`h${i}`}
                      aria-hidden="true"
                      className="absolute inset-x-0"
                      style={{ top: (s.from - start) * PX, height: (s.to - s.from) * PX, backgroundImage: "repeating-linear-gradient(135deg, #f2efe8 0 6px, var(--color-paper) 6px 12px)" }}
                    />
                  ))}
                  {free.map((s) => (
                    <button
                      key={`f${s.from}`}
                      type="button"
                      onClick={() => onBook(dentist.id, minutesToTime(s.from))}
                      aria-label={`Cakto termin te ${dentist.fullName}: e lirë ${minutesToTime(s.from)}–${minutesToTime(s.to)}`}
                      className="absolute inset-x-1.5 grid place-items-center rounded-lg border border-dashed border-brand-200 text-xs text-brand-700 transition-colors hover:border-brand-500 hover:bg-brand-50"
                      style={{ top: (s.from - start) * PX + 0.5, height: (s.to - s.from) * PX - 1, minHeight: 0 }}
                    >
                      {s.to - s.from >= 30 ? `E lirë ${minutesToTime(s.from)}–${minutesToTime(s.to)}` : "+"}
                    </button>
                  ))}
                  {mine.map(({ a, from, to }) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onOpen(a.id)}
                      aria-label={`${fmtTime(a.startsAt, zone)}, ${a.patientName}, ${a.serviceName}, ${STATUS_WORD[a.status]}`}
                      className={`absolute inset-x-1.5 overflow-hidden rounded-lg border-l-4 px-2.5 text-left text-sm leading-tight transition-shadow hover:shadow-card ${STATUS_STYLE[a.status]}`}
                      style={{ top: (from - start) * PX + 1, height: Math.max((to - from) * PX - 2, minBlock), minHeight: 0 }}
                    >
                      <span className="block truncate font-semibold">
                        <span className="tabular-nums">{fmtTime(a.startsAt, zone)}</span> · {a.patientName}
                      </span>
                      {to - from >= 40 ? <span className="block truncate text-xs text-ink-soft">{a.serviceName}</span> : null}
                    </button>
                  ))}
                  {isToday && nowMinute >= start && nowMinute <= end ? (
                    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger-600" style={{ top: (nowMinute - start) * PX }} />
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        <span className="rounded-full bg-info-bg px-2 py-0.5 text-info-fg">I caktuar</span>
        <span className="rounded-full bg-ok-bg px-2 py-0.5 text-ok-fg">I kryer</span>
        <span className="rounded-full bg-warn-bg px-2 py-0.5 text-warn-fg">Nuk erdhi</span>
        <span>Vija të pjerrëta: jashtë orarit ose pushim.{isToday ? " Vija e kuqe: ora tani." : ""}</span>
      </p>
    </div>
  );
}
