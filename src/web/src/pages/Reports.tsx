import { useEffect, useState } from "react";
import { useSession } from "../auth";
import { AppointmentDialog } from "../components/AppointmentDialog";
import { api, type Appointment } from "../lib/api";
import { fmtDateLong, fmtTime, today } from "../lib/format";
import { Badge, Card, Empty, Input, LoadError, Loading, PageHeader, StatusBadge, useLoad } from "../ui";
import { DayNav } from "./Calendar";

// The owner's report flow: choose a date, see that date's patients, narrow by name, open the appointment
// and read or write what was done.

export function Reports() {
  const { user, clinic } = useSession();
  const zone = clinic.timezone;
  const [date, setDate] = useState(today(zone));
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  // Search a moment after typing stops, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const day = useLoad(() => api.get<{ appointments: Appointment[] }>(`/api/appointments?date=${date}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [date, q]);
  const visits = (day.data?.appointments ?? []).filter((a) => a.status !== "cancelled");
  const written = visits.filter((a) => a.hasReport).length;

  return (
    <>
      <PageHeader title="Raportet" subtitle="Zgjidhni datën, gjeni pacientin dhe hapni terminin për të parë ose shkruar çfarë u punua." />

      <Card className="mb-4 flex flex-wrap items-end gap-4 p-4">
        <div>
          <p className="mb-1.5 text-sm font-medium">1. Data</p>
          <DayNav date={date} onChange={setDate} zone={zone} />
        </div>
        <div className="min-w-56 flex-1">
          <label htmlFor="report-q" className="mb-1.5 block text-sm font-medium">
            2. Emri i pacientit
          </label>
          <Input id="report-q" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Shkruani emrin për të filtruar…" className="!h-8" />
        </div>
      </Card>

      {day.loading && !day.data ? (
        <Loading />
      ) : day.error ? (
        <LoadError message={day.error} onRetry={day.reload} />
      ) : visits.length === 0 ? (
        <Empty title={q ? `Asnjë pacient me emrin "${q}" më ${fmtDateLong(date).toLowerCase()}` : "Asnjë pacient në këtë datë"}>{q ? "Provoni një emër tjetër ose pastroni filtrin." : "Zgjidhni një datë tjetër."}</Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-soft first-letter:uppercase">
            {fmtDateLong(date)} · {visits.length} {visits.length === 1 ? "pacient" : "pacientë"} · {written} me raport
          </p>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {visits.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setOpenId(a.id)} className="grid w-full grid-cols-[4.5rem_1fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-brand-50/60 sm:px-5">
                    <span className="text-lg font-semibold tabular-nums">{fmtTime(a.startsAt, zone)}</span>
                    <span className="min-w-0">
                      <span className="block font-medium break-words sm:truncate">{a.patientName}</span>
                      <span className="block text-sm break-words text-ink-soft sm:truncate">
                        {a.serviceName}
                        {user.role === "admin" ? ` · ${a.dentistName}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {a.hasReport ? <Badge tone="ok">Raport ✓</Badge> : <Badge tone="warn">Pa raport</Badge>}
                      <StatusBadge status={a.status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <AppointmentDialog id={openId} onClose={() => setOpenId(null)} onChanged={day.reload} />
    </>
  );
}
