import { useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../auth";
import { BookLocalDialog } from "../components/BookLocalDialog";
import { api } from "../lib/api";
import { dateOf, fmtDate, today } from "../lib/format";
import { Badge, Button, Card, Empty, LoadError, Loading, PageHeader, useLoad } from "../ui";

// Patients whose report said "next appointment in N days", whose day has come (or is near), and who have
// nothing booked yet. The list the clinic phones from.

interface DueVisit {
  patientId: number;
  patientName: string;
  patientPhone: string | null;
  dentistName: string;
  dueAt: string;
  lastWork: string;
}

export function Due() {
  const { user, clinic } = useSession();
  const zone = clinic.timezone;
  const due = useLoad(() => api.get<{ due: DueVisit[] }>("/api/due-visits"), []);
  const [booking, setBooking] = useState<DueVisit | null>(null);
  const list = due.data?.due ?? [];
  const now = today(zone);

  return (
    <>
      <PageHeader title="Për kontroll" subtitle="Pacientët që duhet të vijnë përsëri sipas raportit të vizitës së fundit dhe nuk kanë ende termin." />
      {due.loading && !due.data ? (
        <Loading />
      ) : due.error ? (
        <LoadError message={due.error} onRetry={due.reload} />
      ) : list.length === 0 ? (
        <Empty title="Askush nuk pret kontroll">Kur në një raport shënoni "termini i radhës pas 14 ditësh", pacienti shfaqet këtu kur t'i vijë koha.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((d) => {
              const date = dateOf(d.dueAt, zone);
              const overdue = date < now;
              return (
                <li key={`${d.patientId}-${d.dueAt}`} className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <Link to={`/app/pacientet/${d.patientId}`} className="tap font-medium hover:underline">
                        {d.patientName}
                      </Link>
                      <Badge tone={overdue ? "danger" : "warn"}>{overdue ? `Duhej më ${fmtDate(date)}` : `Më ${fmtDate(date)}`}</Badge>
                    </p>
                    <p className="mt-0.5 text-sm break-words text-ink-soft sm:truncate">
                      {user.role === "admin" ? `${d.dentistName} · ` : ""}
                      Vizita e fundit: {d.lastWork}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {d.patientPhone ? (
                      <a href={`tel:${d.patientPhone}`} className="tap text-sm font-medium text-brand-700 underline underline-offset-2">
                        {d.patientPhone}
                      </a>
                    ) : (
                      <span className="text-sm text-ink-faint">Pa telefon</span>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => setBooking(d)}>
                      Cakto termin
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <BookLocalDialog
        open={booking !== null}
        onClose={() => setBooking(null)}
        onBooked={due.reload}
        date={booking && dateOf(booking.dueAt, zone) > now ? dateOf(booking.dueAt, zone) : now}
        patient={booking ? { id: booking.patientId, fullName: booking.patientName } : null}
      />
    </>
  );
}
