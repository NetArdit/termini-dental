import { useState } from "react";
import { useSession } from "../auth";
import { AppointmentDialog } from "../components/AppointmentDialog";
import { BookLocalDialog } from "../components/BookLocalDialog";
import { DayTimetable } from "../components/DayTimetable";
import { api, type Appointment, type Staff } from "../lib/api";
import { addDays, dayChip, fmtDateLong, fmtTime, today } from "../lib/format";
import { Badge, Button, Card, Empty, Input, LoadError, Loading, PageHeader, Select, StatusBadge, useLoad } from "../ui";

// The day: every appointment of one date, for one dentist or (administrator) the whole clinic.

export function DayNav({ date, onChange, zone }: { date: string; onChange: (date: string) => void; zone: string }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="sm" aria-label="Dita e kaluar" onClick={() => onChange(addDays(date, -1))}>
        ←
      </Button>
      <Input type="date" aria-label="Data" value={date} onChange={(e) => e.target.value && onChange(e.target.value)} className="!h-8 !w-40" />
      <Button variant="secondary" size="sm" aria-label="Dita tjetër" onClick={() => onChange(addDays(date, 1))}>
        →
      </Button>
      <Button variant="ghost" size="sm" disabled={date === today(zone)} onClick={() => onChange(today(zone))}>
        Sot
      </Button>
    </div>
  );
}

export function AppointmentRow({ a, zone, showDentist, onOpen }: { a: Appointment; zone: string; showDentist: boolean; onOpen: () => void }) {
  const cancelled = a.status === "cancelled";
  return (
    <li>
      <button type="button" onClick={onOpen} className="grid w-full grid-cols-[3.75rem_1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-brand-50/60 sm:grid-cols-[4.5rem_1fr_auto] sm:gap-4 sm:px-5">
        <span className={`text-lg font-semibold tabular-nums ${cancelled ? "text-ink-faint line-through" : ""}`}>{fmtTime(a.startsAt, zone)}</span>
        <span className="min-w-0">
          <span className={`block font-medium break-words sm:truncate ${cancelled ? "text-ink-faint" : ""}`}>{a.patientName}</span>
          {/* Wraps instead of being cut off: on a phone "service · dentist" does not fit on one line. */}
          <span className="block text-sm text-ink-soft sm:truncate">
            {a.serviceName}
            {showDentist ? ` · ${a.dentistName}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          {a.lastEmailStatus === "failed" ? <Badge tone="danger">Email i padërguar</Badge> : null}
          {a.hasReport ? <Badge tone="ok">Raport ✓</Badge> : null}
          <StatusBadge status={a.status} />
        </span>
      </button>
    </li>
  );
}

type View = "orari" | "lista";
const VIEW_KEY = "termini.calendar.view";

/** Which of the two views this browser last used. Only that one word is kept; nothing about anyone. */
function rememberedView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "lista" ? "lista" : "orari";
  } catch {
    return "orari";
  }
}

/** Monday of the week a date falls in. */
function mondayOf(date: string): string {
  return addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/** The week of the shown day: each day with its number of appointments, and how full it is next to the others. */
function WeekStrip({ date, counts, onChange }: { date: string; counts: Array<{ date: string; count: number }>; onChange: (date: string) => void }) {
  const most = Math.max(1, ...counts.map((c) => c.count));
  return (
    <div className="mb-4 grid grid-cols-7 gap-1.5 sm:gap-2" role="group" aria-label="Java">
      {counts.map((c) => {
        const chip = dayChip(c.date);
        const selected = c.date === date;
        return (
          <button
            key={c.date}
            type="button"
            aria-pressed={selected}
            aria-label={`${fmtDateLong(c.date)}: ${c.count} ${c.count === 1 ? "termin" : "termine"}`}
            onClick={() => onChange(c.date)}
            className={`rounded-xl border px-1 py-2 text-center transition-colors sm:px-2.5 sm:text-left ${selected ? "border-brand-700 bg-brand-700 text-white" : c.count ? "border-line-strong bg-surface hover:border-brand-200 hover:bg-brand-50" : "border-transparent text-ink-faint hover:bg-surface"}`}
          >
            <span className="block text-xs">{chip.weekday}</span>
            <span className="block text-lg leading-tight font-semibold">{chip.day}</span>
            <span className="block text-xs">
              {c.count}
              <span className="max-sm:hidden"> {c.count === 1 ? "termin" : "termine"}</span>
            </span>
            <span className={`mt-1.5 block h-1 overflow-hidden rounded-full ${selected ? "bg-white/25" : "bg-brand-100"}`} aria-hidden="true">
              <span className={`block h-full rounded-full ${selected ? "bg-white" : "bg-brand-500"}`} style={{ width: `${Math.round((c.count / most) * 100)}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Calendar() {
  const { user, clinic } = useSession();
  const zone = clinic.timezone;
  const [date, setDate] = useState(today(zone));
  const [dentistId, setDentistId] = useState<number | "">("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [booking, setBooking] = useState<{ dentistId?: number; time?: string } | null>(null);
  const [view, setView] = useState<View>(rememberedView);

  // Everyone may read the clinic's staff list; a dentist needs it to know whether they themselves take patients.
  const staff = useLoad(() => api.get<{ staff: Staff[] }>("/api/staff"), []);
  const day = useLoad(() => api.get<{ appointments: Appointment[] }>(`/api/appointments?date=${date}${dentistId ? `&dentistId=${dentistId}` : ""}`), [date, dentistId]);
  const weekStart = mondayOf(date);
  const week = useLoad(() => api.get<{ days: Array<{ date: string; count: number }> }>(`/api/appointments/counts?from=${weekStart}&days=7${dentistId ? `&dentistId=${dentistId}` : ""}`), [weekStart, dentistId]);

  const list = day.data?.appointments ?? [];
  const live = list.filter((a) => a.status !== "cancelled");
  const dentists = (staff.data?.staff ?? []).filter((s) => s.isBookable && s.isActive);
  // The columns of the timetable: what this person may see. The server decides which appointments come back.
  const columns = user.role === "admin" ? (dentistId ? dentists.filter((d) => d.id === dentistId) : dentists) : dentists.filter((d) => d.id === user.id);

  function chooseView(next: View) {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private browsing may refuse; the choice then lasts for this visit only.
    }
  }
  const reload = () => {
    day.reload();
    week.reload();
  };

  return (
    <>
      <PageHeader
        title="Kalendari"
        subtitle={fmtDateLong(date)}
        actions={
          <Button onClick={() => setBooking({})}>
            <span aria-hidden="true">+</span> Termin i ri
          </Button>
        }
      />

      <WeekStrip date={date} counts={week.data?.days ?? Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekStart, i), count: 0 }))} onChange={setDate} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DayNav date={date} onChange={setDate} zone={zone} />
        <div className="flex rounded-lg border border-line-strong bg-surface p-0.5" role="group" aria-label="Pamja e kalendarit">
          {(["orari", "lista"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => chooseView(v)}
              className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${view === v ? "bg-brand-700 text-white" : "text-ink-soft hover:text-ink"}`}
            >
              {v === "orari" ? "Orari" : "Lista"}
            </button>
          ))}
        </div>
        {user.role === "admin" && dentists.length > 1 ? (
          <Select aria-label="Stomatologu" value={dentistId} onChange={(e) => setDentistId(e.target.value ? Number(e.target.value) : "")} className="!h-8 !w-56 !text-sm">
            <option value="">Të gjithë stomatologët</option>
            {dentists.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fullName}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {day.loading && !day.data ? (
        <Loading />
      ) : day.error ? (
        <LoadError message={day.error} onRetry={day.reload} />
      ) : view === "orari" && columns.length > 0 ? (
        <>
          <p className="mb-2 text-sm text-ink-soft">
            {live.length} {live.length === 1 ? "termin" : "termine"}
            {list.length !== live.length ? (
              <>
                {" · "}
                <button type="button" onClick={() => chooseView("lista")} className="underline underline-offset-2 hover:text-ink">
                  {list.length - live.length} të anuluara (shihen te Lista)
                </button>
              </>
            ) : null}
          </p>
          <DayTimetable date={date} zone={zone} dentists={columns} appointments={list} onOpen={setOpenId} onBook={(id, time) => setBooking({ dentistId: id, time })} />
        </>
      ) : list.length === 0 ? (
        <Empty title="Asnjë termin këtë ditë">Caktoni një termin për një pacient, ose ndani linkun e klinikës që pacientët të rezervojnë vetë.</Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-soft">
            {live.length} {live.length === 1 ? "termin" : "termine"}
            {list.length !== live.length ? ` · ${list.length - live.length} të anuluara` : ""}
          </p>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {list.map((a) => (
                <AppointmentRow key={a.id} a={a} zone={zone} showDentist={user.role === "admin" && !dentistId} onOpen={() => setOpenId(a.id)} />
              ))}
            </ul>
          </Card>
        </>
      )}

      <AppointmentDialog id={openId} onClose={() => setOpenId(null)} onChanged={reload} />
      <BookLocalDialog
        open={booking !== null}
        onClose={() => setBooking(null)}
        onBooked={reload}
        date={date < today(zone) ? today(zone) : date}
        dentistId={booking?.dentistId ?? (dentistId || undefined)}
        time={booking?.time}
      />
    </>
  );
}
