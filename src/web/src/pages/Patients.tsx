import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useSession } from "../auth";
import { AppointmentDialog } from "../components/AppointmentDialog";
import { BookLocalDialog } from "../components/BookLocalDialog";
import { ApiError, api, type Patient, type Staff, type Visit } from "../lib/api";
import { fmtDate, fmtDateTime, today } from "../lib/format";
import { Badge, Button, Card, Empty, Field, Input, LoadError, Loading, Modal, Notice, PageHeader, Select, StatusBadge, Textarea, useLoad, useToast } from "../ui";

// The clinic's patients: those who booked online and those the clinic added itself (owner's rule 4).

type PatientForm = { fullName: string; phone: string; email: string; birthDate: string; note: string; dentistId: number | "" };
const EMPTY: PatientForm = { fullName: "", phone: "", email: "", birthDate: "", note: "", dentistId: "" };

function PatientFormDialog({ open, onClose, onSaved, existing }: { open: boolean; onClose: () => void; onSaved: (p: Patient) => void; existing?: Patient }) {
  const { user } = useSession();
  const toast = useToast();
  const [form, setForm] = useState<PatientForm>(EMPTY);
  const [dentists, setDentists] = useState<Staff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFields({});
    setForm(existing ? { fullName: existing.fullName, phone: existing.phone ?? "", email: existing.email ?? "", birthDate: existing.birthDate ?? "", note: existing.note ?? "", dentistId: existing.dentistId } : EMPTY);
    if (user.role === "admin") {
      void api.get<{ staff: Staff[] }>("/api/staff").then((res) => {
        const bookable = res.staff.filter((s) => s.isActive && s.isBookable);
        setDentists(bookable);
        if (!existing) setForm((f) => ({ ...f, dentistId: bookable.find((b) => b.id === user.id)?.id ?? bookable[0]?.id ?? "" }));
      });
    }
  }, [open, existing, user]);

  const set = (key: keyof PatientForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    setFields({});
    const body = { ...form, dentistId: user.role === "admin" && form.dentistId ? Number(form.dentistId) : undefined };
    try {
      const res = existing ? await api.patch<{ patient: Patient }>(`/api/patients/${existing.id}`, body) : await api.post<{ patient: Patient }>("/api/patients", body);
      toast(existing ? "Ndryshimet u ruajtën" : "Pacienti u shtua");
      onSaved(res.patient);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError("Ruajtja dështoi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? "Ndrysho pacientin" : "Pacient i ri"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Mbyll
          </Button>
          <Button busy={busy} onClick={save}>
            Ruaj
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label="Emri dhe mbiemri" error={fields.fullName}>
          {(p) => <Input {...p} value={form.fullName} onChange={set("fullName")} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Telefoni" error={fields.phone}>
            {(p) => <Input {...p} type="tel" value={form.phone} onChange={set("phone")} />}
          </Field>
          <Field label="Email" error={fields.email}>
            {(p) => <Input {...p} type="email" value={form.email} onChange={set("email")} />}
          </Field>
          <Field label="Data e lindjes" error={fields.birthDate}>
            {(p) => <Input {...p} type="date" max={today()} value={form.birthDate} onChange={set("birthDate")} />}
          </Field>
          {user.role === "admin" && dentists.length > 1 ? (
            <Field label="Stomatologu përgjegjës" error={fields.dentistId}>
              {(p) => (
                <Select {...p} value={form.dentistId} onChange={(e) => setForm((f) => ({ ...f, dentistId: Number(e.target.value) }))}>
                  {dentists.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        <Field label="Shënim" hint="p.sh. alergji, sëmundje, barna që merr." error={fields.note}>
          {(p) => <Textarea {...p} rows={3} value={form.note} onChange={set("note")} />}
        </Field>
      </div>
    </Modal>
  );
}

export function Patients() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const list = useLoad(() => api.get<{ patients: Patient[] }>(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`), [q]);
  const patients = list.data?.patients ?? [];

  return (
    <>
      <PageHeader
        title="Pacientët"
        subtitle={user.role === "admin" ? "Të gjithë pacientët e klinikës." : "Pacientët tuaj."}
        actions={
          <Button onClick={() => setAdding(true)}>
            <span aria-hidden="true">+</span> Pacient i ri
          </Button>
        }
      />
      <Input type="search" aria-label="Kërko pacient" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Kërko me emër, telefon ose email…" className="mb-4 max-w-md" />

      {list.loading && !list.data ? (
        <Loading />
      ) : list.error ? (
        <LoadError message={list.error} onRetry={list.reload} />
      ) : patients.length === 0 ? (
        <Empty title={q ? "Asnjë pacient nuk përputhet" : "Ende asnjë pacient"}>{q ? "Provoni një kërkim tjetër." : "Shtoni pacientin e parë, ose prisni rezervimet online."}</Empty>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {patients.map((p) => (
              <li key={p.id}>
                <Link to={`/app/pacientet/${p.id}`} className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-brand-50/60 sm:px-5">
                  <span className="min-w-0">
                    <span className="block font-medium break-words sm:truncate">{p.fullName}</span>
                    <span className="block text-sm break-words text-ink-soft sm:truncate">
                      {[p.phone, p.email].filter(Boolean).join(" · ") || "Pa kontakt"}
                      {user.role === "admin" ? ` · ${p.dentistName}` : ""}
                    </span>
                  </span>
                  <Badge>{p.source === "online" ? "Online" : "Lokal"}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PatientFormDialog open={adding} onClose={() => setAdding(false)} onSaved={(p) => navigate(`/app/pacientet/${p.id}`)} />
    </>
  );
}

export function PatientDetail() {
  const { id = "" } = useParams();
  const { user, clinic } = useSession();
  const zone = clinic.timezone;
  const detail = useLoad(() => api.get<{ patient: Patient; visits: Visit[] }>(`/api/patients/${encodeURIComponent(id)}`), [id]);
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error || !detail.data) return <LoadError message={detail.error ?? "Pacienti nuk u gjet."} onRetry={detail.reload} />;
  const { patient, visits } = detail.data;

  return (
    <>
      <Link to="/app/pacientet" className="tap mb-3 inline-block text-sm font-medium text-brand-700 hover:underline">
        ← Pacientët
      </Link>
      <PageHeader
        title={patient.fullName}
        subtitle={`${patient.source === "online" ? "Rezervoi online" : "Shtuar nga klinika"} · stomatologu përgjegjës: ${patient.dentistName}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Ndrysho
            </Button>
            <Button onClick={() => setBooking(true)}>
              <span aria-hidden="true">+</span> Termin i ri
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card className="h-fit space-y-3 p-5 text-[15px]">
          {[
            ["Telefoni", patient.phone],
            ["Email", patient.email],
            ["Data e lindjes", patient.birthDate ? fmtDate(patient.birthDate) : null],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-xs font-medium text-ink-faint">{label}</p>
              <p className={value ? "break-words" : "text-ink-faint"}>{value ?? "—"}</p>
            </div>
          ))}
          {patient.note ? (
            <div className="rounded-xl bg-warn-bg p-3 text-warn-fg">
              <p className="text-xs font-semibold">Shënim</p>
              <p className="whitespace-pre-wrap">{patient.note}</p>
            </div>
          ) : null}
        </Card>

        <div>
          <h2 className="mb-3 font-display text-xl font-semibold tracking-tight">Vizitat</h2>
          {visits.length === 0 ? (
            <Empty title="Ende asnjë vizitë" />
          ) : (
            <ol className="space-y-3">
              {visits.map((v) => {
                const body = (
                  <>
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium first-letter:uppercase">{fmtDateTime(v.startsAt, zone)}</span>
                      <StatusBadge status={v.status} />
                    </span>
                    <span className="mt-0.5 block text-sm text-ink-soft">
                      {v.serviceName} · {v.dentistName}
                    </span>
                    {v.workDone ? (
                      <span className="mt-3 block border-t border-line pt-3 whitespace-pre-wrap">{v.workDone}</span>
                    ) : v.status !== "cancelled" ? (
                      <span className="mt-3 block border-t border-line pt-3 text-sm text-ink-faint">Pa raport</span>
                    ) : null}
                    {v.nextVisitDays ? <span className="mt-2 block text-sm font-medium text-brand-700">Termini i radhës pas {v.nextVisitDays} ditësh</span> : null}
                  </>
                );
                const card = "block w-full rounded-2xl border border-line bg-surface p-4 text-left shadow-card";
                // The whole history is shown, but a visit is opened (and its report written) only by the
                // dentist who treated it or by the administrator. The server decides; this mirrors it.
                return (
                  <li key={v.id}>
                    {user.role === "admin" || v.dentistId === user.id ? (
                      <button type="button" onClick={() => setOpenId(v.id)} className={`${card} transition-colors hover:border-brand-200`}>
                        {body}
                      </button>
                    ) : (
                      <div className={card}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>

      <PatientFormDialog open={editing} onClose={() => setEditing(false)} onSaved={detail.reload} existing={patient} />
      <BookLocalDialog open={booking} onClose={() => setBooking(false)} onBooked={detail.reload} date={today(zone)} patient={{ id: patient.id, fullName: patient.fullName }} dentistId={patient.dentistId} />
      <AppointmentDialog id={openId} onClose={() => setOpenId(null)} onChanged={detail.reload} />
    </>
  );
}
