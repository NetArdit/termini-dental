import { useEffect, useState } from "react";
import { useSession } from "../auth";
import { ApiError, api, type Patient, type Service, type Staff } from "../lib/api";
import { fmtDuration, fmtTime, zonedInstant } from "../lib/format";
import { Button, Field, Input, Modal, Notice, Select, useToast } from "../ui";

// The clinic books an appointment itself, for a patient who came in or phoned. The 36-hour rule does not
// apply here: it is about patients booking alone.

export function BookLocalDialog({
  open,
  onClose,
  onBooked,
  date,
  dentistId,
  time,
  patient,
}: {
  open: boolean;
  onClose: () => void;
  onBooked: () => void;
  /** The day to start on. */
  date: string;
  dentistId?: number;
  /** A start time ("HH:MM") to begin with, when the dialog was opened from a free stretch of the timetable. */
  time?: string;
  /** When given, the appointment is for this existing patient. */
  patient?: { id: number; fullName: string } | null;
}) {
  const { user, clinic } = useSession();
  const zone = clinic.timezone;
  const toast = useToast();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [form, setForm] = useState({ dentistId: 0, serviceId: 0, date, time: "" });
  const [slots, setSlots] = useState<string[] | null>(null);
  const [customTime, setCustomTime] = useState("");
  const [mode, setMode] = useState<"existing" | "new">(patient ? "existing" : "new");
  const [chosen, setChosen] = useState<{ id: number; fullName: string } | null>(patient ?? null);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Patient[]>([]);
  const [fresh, setFresh] = useState({ fullName: "", phone: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Reset every time the dialog opens, and load what the selects need.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setFields({});
    // A time handed in from the timetable starts as the typed time; the staff can still pick another.
    setCustomTime(time ?? "");
    setSearch("");
    setFound([]);
    setFresh({ fullName: "", phone: "", email: "" });
    setMode(patient ? "existing" : "new");
    setChosen(patient ?? null);
    void Promise.all([api.get<{ staff: Staff[] }>("/api/staff"), api.get<{ services: Service[] }>("/api/services")]).then(([s, sv]) => {
      const bookable = s.staff.filter((x) => x.isActive && x.isBookable && (user.role === "admin" || x.id === user.id));
      const active = sv.services.filter((x) => x.isActive);
      setStaff(bookable);
      setServices(active);
      setForm({ dentistId: dentistId && bookable.some((b) => b.id === dentistId) ? dentistId : (bookable[0]?.id ?? 0), serviceId: active[0]?.id ?? 0, date, time: "" });
    });
    // `patient` is compared by id: callers pass a fresh object on every render, which must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, date, dentistId, time, patient?.id, user]);

  // Free times of the chosen dentist on the chosen day.
  useEffect(() => {
    if (!open || !form.dentistId || !form.serviceId || !form.date) return;
    let current = true;
    setSlots(null);
    api.get<{ slots: string[] }>(`/api/slots?dentistId=${form.dentistId}&serviceId=${form.serviceId}&date=${form.date}`).then(
      (res) => current && setSlots(res.slots),
      () => current && setSlots([]),
    );
    return () => {
      current = false;
    };
  }, [open, form.dentistId, form.serviceId, form.date]);

  // Patient search, a moment after typing stops.
  useEffect(() => {
    if (mode !== "existing" || chosen || search.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api.get<{ patients: Patient[] }>(`/api/patients?q=${encodeURIComponent(search.trim())}`).then(
        (res) => setFound(res.patients.slice(0, 6)),
        () => setFound([]),
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [mode, chosen, search]);

  const service = services.find((s) => s.id === form.serviceId);
  const startsAt = customTime ? zonedInstant(form.date, customTime, zone).toISOString() : form.time;
  const patientReady = mode === "existing" ? Boolean(chosen) : fresh.fullName.trim().length >= 3;

  async function submit() {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await api.post<{ emailStatus: string }>("/api/appointments", {
        dentistId: form.dentistId,
        serviceId: form.serviceId,
        startsAt,
        ...(mode === "existing" ? { patientId: chosen!.id } : { newPatient: fresh }),
      });
      // "stored" means no mail server is configured: the patient got nothing, and staff should know.
      const unsent = res.emailStatus === "failed" || res.emailStatus === "stored";
      toast(unsent ? "Termini u caktua, por emaili i konfirmimit nuk u dërgua." : "Termini u caktua", unsent ? "danger" : "ok");
      onBooked();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        // Field names of a new patient arrive as "newPatient.fullName".
        setFields(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k.replace("newPatient.", ""), v])));
      } else setError("Caktimi dështoi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Termin i ri"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Mbyll
          </Button>
          <Button busy={busy} disabled={!startsAt || !patientReady || !form.dentistId || !form.serviceId} onClick={submit}>
            Cakto terminin
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {staff.length === 0 && services.length > 0 ? <Notice tone="warn">Asnjë stomatolog nuk pranon termine. Aktivizojeni te Cilësimet.</Notice> : null}

        <div className="grid gap-4 sm:grid-cols-3">
          {user.role === "admin" ? (
            <Field label="Stomatologu">
              {(p) => (
                <Select {...p} value={form.dentistId} onChange={(e) => setForm({ ...form, dentistId: Number(e.target.value), time: "" })}>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Field label="Shërbimi">
            {(p) => (
              <Select {...p} value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: Number(e.target.value), time: "" })}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({fmtDuration(s.durationMinutes)})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Data">{(p) => <Input {...p} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value, time: "" })} />}</Field>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">Ora</p>
          {slots === null ? (
            <p className="text-sm text-ink-soft">Duke kërkuar oraret e lira…</p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-ink-soft">Nuk ka orare të lira sipas orarit të punës për këtë ditë.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={!customTime && form.time === s}
                  onClick={() => {
                    setForm({ ...form, time: s });
                    setCustomTime("");
                  }}
                  className={`h-9 rounded-lg border px-3 text-sm font-medium tabular-nums transition-colors ${!customTime && form.time === s ? "border-brand-700 bg-brand-700 text-white" : "border-line-strong bg-surface hover:bg-brand-50"}`}
                >
                  {fmtTime(s, zone)}
                </button>
              ))}
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
            Ose orë tjetër:
            <input type="time" value={customTime} onChange={(e) => setCustomTime(e.target.value)} className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-ink" />
          </label>
          {fields.startsAt ? <p className="mt-1 text-sm text-danger-fg">{fields.startsAt}</p> : null}
        </div>

        <div className="border-t border-line pt-5">
          <div className="mb-3 flex items-center gap-2">
            <p className="mr-auto text-sm font-medium">Pacienti</p>
            {!patient ? (
              <div className="flex rounded-lg border border-line-strong p-0.5 text-sm font-medium">
                {(["new", "existing"] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`rounded-md px-3 py-1 ${mode === m ? "bg-brand-700 text-white" : "text-ink-soft hover:bg-brand-50"}`}>
                    {m === "new" ? "I ri" : "Ekzistues"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {mode === "existing" ? (
            chosen ? (
              <div className="flex items-center justify-between rounded-xl bg-brand-50 px-4 py-3">
                <span className="font-medium">{chosen.fullName}</span>
                {!patient ? (
                  <button type="button" className="text-sm font-medium text-brand-700 underline" onClick={() => setChosen(null)}>
                    Ndrysho
                  </button>
                ) : null}
              </div>
            ) : (
              <div>
                <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Kërko me emër ose telefon…" aria-label="Kërko pacientin" />
                {found.length ? (
                  <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {found.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => setChosen({ id: p.id, fullName: p.fullName })} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-brand-50">
                          <span className="font-medium">{p.fullName}</span>
                          <span className="text-sm text-ink-soft">{p.phone ?? p.email ?? ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : search.trim().length >= 2 ? (
                  <p className="mt-2 text-sm text-ink-soft">Asnjë pacient me këtë emër. Shtojeni si të ri.</p>
                ) : null}
              </div>
            )
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="Emri dhe mbiemri" error={fields.fullName}>
                  {(p) => <Input {...p} value={fresh.fullName} onChange={(e) => setFresh({ ...fresh, fullName: e.target.value })} />}
                </Field>
              </div>
              <Field label="Telefoni" error={fields.phone}>
                {(p) => <Input {...p} type="tel" value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} />}
              </Field>
              <Field label="Email" error={fields.email} hint="Pa email, pacienti nuk merr njoftime.">
                {(p) => <Input {...p} type="email" value={fresh.email} onChange={(e) => setFresh({ ...fresh, email: e.target.value })} />}
              </Field>
            </div>
          )}
        </div>

        {service && startsAt ? (
          <p className="rounded-xl bg-brand-50 px-4 py-3 text-sm">
            <span className="font-medium">{fmtTime(startsAt, zone)}</span> · {service.name} · {fmtDuration(service.durationMinutes)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
