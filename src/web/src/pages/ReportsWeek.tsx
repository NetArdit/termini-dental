import { useState } from "react";
import { useSession } from "../auth";
import { AppointmentDialog } from "../components/AppointmentDialog";
import { api } from "../lib/api";
import { addDays, fmtDateLong, fmtTime, today } from "../lib/format";
import { Button, Card, Empty, LoadError, Loading, useLoad } from "../ui";

// Every report of one week, day by day, with the week's dates down the side to jump to. The arrows move a
// week at a time, so a report from three weeks ago is three presses away, not twenty-one.

interface WeekReport {
  appointmentId: number;
  date: string;
  startsAt: string;
  patientName: string;
  dentistName: string;
  serviceName: string;
  workDone: string;
  nextVisitDays: number | null;
  version: number;
  images: number;
}
interface Week {
  from: string;
  to: string;
  days: Array<{ date: string; count: number }>;
  reports: WeekReport[];
}

const WEEKDAY = ["", "Hën", "Mar", "Mër", "Enj", "Pre", "Sht", "Die"];
const dayMonth = (date: string) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}`;

export function ReportsWeek() {
  const { user, clinic } = useSession();
  const zone = clinic.timezone;
  const now = today(zone);
  const [anchor, setAnchor] = useState(now);
  const [openId, setOpenId] = useState<number | null>(null);
  const week = useLoad(() => api.get<Week>(`/api/reports/week?date=${anchor}`), [anchor]);
  const data = week.data;
  const thisWeek = data ? now >= data.from && now <= data.to : true;

  const jumpTo = (date: string) => {
    const el = document.getElementById(`reports-${date}`);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" aria-label="Java e kaluar" onClick={() => setAnchor(addDays(data?.from ?? anchor, -7))}>
          ←
        </Button>
        <p className="min-w-52 text-center text-lg font-semibold tracking-tight" aria-live="polite">
          {data ? `${dayMonth(data.from)} – ${dayMonth(data.to)}.${data.to.slice(0, 4)}` : "…"}
        </p>
        <Button variant="secondary" aria-label="Java tjetër" onClick={() => setAnchor(addDays(data?.from ?? anchor, 7))}>
          →
        </Button>
        <Button variant="ghost" size="sm" disabled={thisWeek} onClick={() => setAnchor(now)}>
          Kjo javë
        </Button>
        {data ? (
          <p className="ml-auto text-sm text-ink-soft">
            {data.reports.length} {data.reports.length === 1 ? "raport" : "raporte"} këtë javë
          </p>
        ) : null}
      </div>

      {week.loading && !data ? (
        <Loading />
      ) : week.error || !data ? (
        <LoadError message={week.error ?? "Raportet nuk u ngarkuan."} onRetry={week.reload} />
      ) : (
        <div className="grid gap-4 md:grid-cols-[11rem_1fr] md:items-start">
          {/* The week's dates: each says how many reports it has and jumps to them. */}
          <nav aria-label="Ditët e javës" className="md:sticky md:top-4">
            <ul className="flex gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
              {data.days.map((d, i) => (
                <li key={d.date} className="shrink-0">
                  <button
                    type="button"
                    disabled={d.count === 0}
                    onClick={() => jumpTo(d.date)}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${d.count ? "border-line bg-surface hover:border-brand-200 hover:bg-brand-50" : "border-transparent text-ink-faint"} ${d.date === now ? "ring-2 ring-brand-200" : ""}`}
                    aria-label={`${fmtDateLong(d.date)}: ${d.count === 0 ? "asnjë raport" : d.count === 1 ? "1 raport" : `${d.count} raporte`}`}
                  >
                    <span>
                      <span className="font-semibold">{WEEKDAY[i + 1]}</span> <span className="tabular-nums">{dayMonth(d.date)}</span>
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${d.count ? "bg-brand-50 text-brand-700" : ""}`}>{d.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {data.reports.length === 0 ? (
            <Empty title="Asnjë raport këtë javë">Raportet shkruhen te termini, në ditën e vizitës ose më pas. Me shigjetat kaloni te javët e tjera.</Empty>
          ) : (
            <div className="space-y-6">
              {data.days
                .filter((d) => d.count > 0)
                .map((d) => (
                  <section key={d.date} id={`reports-${d.date}`} tabIndex={-1} aria-labelledby={`reports-h-${d.date}`} className="scroll-mt-4 outline-none">
                    <h2 id={`reports-h-${d.date}`} className="mb-2 text-base font-semibold tracking-tight first-letter:uppercase">
                      {fmtDateLong(d.date)}
                    </h2>
                    <ul className="space-y-3">
                      {data.reports
                        .filter((r) => r.date === d.date)
                        .map((r) => (
                          <li key={r.appointmentId}>
                            <button type="button" onClick={() => setOpenId(r.appointmentId)} className="block w-full text-left">
                              <Card className="p-4 transition-shadow hover:shadow-pop">
                                <span className="flex flex-wrap items-baseline justify-between gap-2">
                                  <span className="font-semibold">
                                    <span className="tabular-nums text-ink-soft">{fmtTime(r.startsAt, zone)}</span> · {r.patientName}
                                  </span>
                                  <span className="text-sm text-ink-soft">
                                    {r.serviceName}
                                    {user.role === "admin" ? ` · ${r.dentistName}` : ""}
                                  </span>
                                </span>
                                <span className="mt-2 line-clamp-3 block whitespace-pre-wrap text-[15px] text-ink">{r.workDone}</span>
                                <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                                  {r.nextVisitDays ? <span className="font-medium text-brand-700">Kontrolli i radhës pas {r.nextVisitDays} ditësh</span> : null}
                                  {r.images ? <span>{r.images === 1 ? "1 fotografi" : `${r.images} fotografi`}</span> : null}
                                  {r.version > 1 ? <span>Korrigjuar {r.version - 1} herë</span> : null}
                                </span>
                              </Card>
                            </button>
                          </li>
                        ))}
                    </ul>
                  </section>
                ))}
            </div>
          )}
        </div>
      )}
      <AppointmentDialog id={openId} onClose={() => setOpenId(null)} onChanged={week.reload} />
    </>
  );
}
