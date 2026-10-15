import { useMemo, useState } from "react";
import { useSession } from "../auth";
import { AppointmentDialog } from "../components/AppointmentDialog";
import { api, type Appointment, type Staff } from "../lib/api";
import { dateOf, fmtDateLong, today } from "../lib/format";
import { Button, Card, Empty, LoadError, Loading, PageHeader, Select, useLoad } from "../ui";
import { AppointmentRow } from "./Calendar";

// The booked appointments of a whole month, day by day: what is ahead, without the free time, the cancelled
// and the finished ones that the calendar also shows. A dentist sees their own; the administrator sees
// everybody's and can narrow to one dentist.

const MONTHS = ["janar", "shkurt", "mars", "prill", "maj", "qershor", "korrik", "gusht", "shtator", "tetor", "nëntor", "dhjetor"];
const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
/** "2026-10" moved by `by` months. */
function shift(month: string, by: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function Appointments() {
  const { user, clinic } = useSession();
  const zone = clinic.timezone;
  const thisMonth = today(zone).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [dentistId, setDentistId] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const staff = useLoad(() => (user.role === "admin" ? api.get<{ staff: Staff[] }>("/api/staff") : Promise.resolve({ staff: [] as Staff[] })), [user.role]);
  const list = useLoad(() => api.get<{ appointments: Appointment[] }>(`/api/appointments/booked?month=${month}${dentistId ? `&dentistId=${dentistId}` : ""}`), [month, dentistId]);

  // One group per day that has something, in the order of the days.
  const days = useMemo(() => {
    const byDay = new Map<string, Appointment[]>();
    for (const a of list.data?.appointments ?? []) {
      const day = dateOf(a.startsAt, zone);
      byDay.set(day, [...(byDay.get(day) ?? []), a]);
    }
    return [...byDay.entries()];
  }, [list.data, zone]);
  const total = list.data?.appointments.length ?? 0;
  const dentists = (staff.data?.staff ?? []).filter((s) => s.isBookable && s.isActive);

  return (
    <>
      <PageHeader title="Terminet" subtitle="Terminet e caktuara të muajit, ditë pas dite." />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button variant="secondary" aria-label="Muaji i kaluar" onClick={() => setMonth(shift(month, -1))}>
          ←
        </Button>
        <p className="min-w-40 text-center text-lg font-semibold tracking-tight first-letter:uppercase" aria-live="polite">
          {monthName(month)}
        </p>
        <Button variant="secondary" aria-label="Muaji tjetër" onClick={() => setMonth(shift(month, 1))}>
          →
        </Button>
        <Button variant="ghost" size="sm" disabled={month === thisMonth} onClick={() => setMonth(thisMonth)}>
          Ky muaj
        </Button>
        {user.role === "admin" && dentists.length > 1 ? (
          <div className="ml-auto">
            <Select aria-label="Stomatologu" value={dentistId} onChange={(e) => setDentistId(e.target.value)}>
              <option value="">Të gjithë stomatologët</option>
              {dentists.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {list.loading && !list.data ? (
        <Loading />
      ) : list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : days.length === 0 ? (
        <Empty title={`Asnjë termin i caktuar në ${monthName(month)}`}>Terminet që caktohen për këtë muaj shfaqen këtu.</Empty>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-soft">
            {total} {total === 1 ? "termin i caktuar" : "termine të caktuara"} në {days.length} {days.length === 1 ? "ditë" : "ditë të ndryshme"}
          </p>
          <div className="space-y-5">
            {days.map(([day, items]) => (
              <section key={day} aria-labelledby={`day-${day}`}>
                <h2 id={`day-${day}`} className="mb-2 flex items-baseline justify-between gap-3">
                  <span className="text-base font-semibold tracking-tight first-letter:uppercase">
                    {fmtDateLong(day)}
                    {day === today(zone) ? <span className="ml-2 rounded-full bg-mint px-2 py-0.5 text-xs font-semibold text-mint-fg">Sot</span> : null}
                  </span>
                  <span className="text-sm text-ink-soft">
                    {items.length} {items.length === 1 ? "termin" : "termine"}
                  </span>
                </h2>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-line" aria-label={`Terminet e caktuara, ${fmtDateLong(day)}`}>
                    {items.map((a) => (
                      <AppointmentRow key={a.id} a={a} zone={zone} showDentist={user.role === "admin" && !dentistId} onOpen={() => setOpenId(a.id)} />
                    ))}
                  </ul>
                </Card>
              </section>
            ))}
          </div>
        </>
      )}
      <AppointmentDialog id={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />
    </>
  );
}
