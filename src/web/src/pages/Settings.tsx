import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAuth, useSession } from "../auth";
import { ApiError, api, type Service, type Staff, type WorkingPeriod } from "../lib/api";
import { WEEKDAYS, fmtDateTime, fmtDuration, minutesToTime, timeToMinutes, today, zonedInstant } from "../lib/format";
import { Badge, Button, Card, Field, Input, LoadError, Loading, Modal, Notice, PageHeader, Select, useLoad, useToast } from "../ui";

// Settings. Every dentist sets their own working hours and days off; the administrator also manages the
// clinic's rules, its staff and its services.

type Tab = "orari" | "klinika" | "stafi" | "sherbimet";

export function Settings() {
  const { user } = useSession();
  const [tab, setTab] = useState<Tab>("orari");
  const baseId = useId();
  const tabs: Array<[Tab, string]> = user.role === "admin" ? [["orari", "Orari i punës"], ["klinika", "Klinika"], ["stafi", "Stafi"], ["sherbimet", "Shërbimet"]] : [["orari", "Orari im"]];

  // The usual keyboard pattern for tabs: one stop in the Tab order, arrows (and Home, End) move between
  // them and open the one they land on.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const at = tabs.findIndex(([key]) => key === tab);
    const to = e.key === "ArrowRight" ? (at + 1) % tabs.length : e.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = tabs[to]![0];
    setTab(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }

  const panel =
    tab === "orari" ? <Schedule /> : tab === "klinika" ? <ClinicSettings /> : tab === "stafi" ? <StaffSettings /> : <ServiceSettings />;

  return (
    <>
      <PageHeader title="Cilësimet" />
      {tabs.length > 1 ? (
        <>
          <div role="tablist" aria-label="Cilësimet" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                id={`${baseId}-tab-${key}`}
                role="tab"
                type="button"
                aria-selected={tab === key}
                aria-controls={`${baseId}-panel`}
                tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)}
                onKeyDown={onTabKey}
                className={`-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${tab === key ? "border-brand-700 text-brand-700" : "border-transparent text-ink-soft hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`}>
            {panel}
          </div>
        </>
      ) : (
        panel
      )}
    </>
  );
}

// ---- working hours and time off --------------------------------------------------------------------------

function Schedule() {
  const { user } = useSession();
  const staff = useLoad(() => api.get<{ staff: Staff[] }>("/api/staff"), []);
  const [staffId, setStaffId] = useState(user.id);
  const bookable = (staff.data?.staff ?? []).filter((s) => s.isActive && s.isBookable);

  // An administrator who does not treat patients starts on the first dentist instead of on themselves.
  useEffect(() => {
    if (bookable.length && !bookable.some((s) => s.id === staffId)) setStaffId(bookable[0]!.id);
  }, [bookable, staffId]);

  if (staff.loading && !staff.data) return <Loading />;
  if (staff.error) return <LoadError message={staff.error} onRetry={staff.reload} />;
  if (!bookable.some((s) => s.id === staffId)) return <Notice tone="info">Asnjë stomatolog nuk pranon termine ende.</Notice>;

  return (
    <div className="space-y-6">
      {user.role === "admin" && bookable.length > 1 ? (
        <div className="max-w-xs">
          <Field label="Stomatologu">
            {(p) => (
              <Select {...p} value={staffId} onChange={(e) => setStaffId(Number(e.target.value))}>
                {bookable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      ) : null}
      <HoursEditor key={`h${staffId}`} staffId={staffId} />
      <TimeOffEditor key={`t${staffId}`} staffId={staffId} />
    </div>
  );
}

interface Row {
  start: string;
  end: string;
}

function HoursEditor({ staffId }: { staffId: number }) {
  const toast = useToast();
  const loaded = useLoad(() => api.get<{ hours: WorkingPeriod[] }>(`/api/staff/${staffId}/hours`), [staffId]);
  const [week, setWeek] = useState<Row[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setWeek(Array.from({ length: 7 }, (_, i) => loaded.data!.hours.filter((h) => h.weekday === i + 1).map((h) => ({ start: minutesToTime(h.startMinute), end: minutesToTime(h.endMinute % 1440) }))));
  }, [loaded.data]);

  if (loaded.error) return <LoadError message={loaded.error} onRetry={loaded.reload} />;
  if (!week) return <Loading />;

  const update = (day: number, fn: (rows: Row[]) => Row[]) => setWeek((w) => w!.map((rows, i) => (i === day ? fn(rows) : rows)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const hours = week!.flatMap((rows, i) =>
        rows.map((r) => ({ weekday: i + 1, startMinute: timeToMinutes(r.start), endMinute: timeToMinutes(r.end) || 1440 })),
      );
      await api.put(`/api/staff/${staffId}/hours`, { hours });
      toast("Orari u ruajt");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ruajtja dështoi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="font-display text-xl font-semibold tracking-tight">Orari javor</h2>
      <p className="mt-1 mb-4 text-sm text-ink-soft">Pacientët mund të rezervojnë vetëm brenda këtyre orëve. Për pauzë dreke, shtoni dy periudha në të njëjtën ditë.</p>
      <ul className="divide-y divide-line">
        {week.map((rows, day) => (
          <li key={day} className="grid gap-2 py-3 sm:grid-cols-[8rem_1fr] sm:items-start">
            <p className="pt-1.5 font-medium">{WEEKDAYS[day]}</p>
            <div className="space-y-2">
              {rows.length === 0 ? <p className="pt-1.5 text-sm text-ink-faint">Nuk punon</p> : null}
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="time" aria-label={`${WEEKDAYS[day]}, fillimi`} value={r.start} onChange={(e) => update(day, (x) => x.map((y, j) => (j === i ? { ...y, start: e.target.value } : y)))} className="h-9 rounded-lg border border-line-strong bg-surface px-2" />
                  <span className="text-ink-faint">–</span>
                  <input type="time" aria-label={`${WEEKDAYS[day]}, mbarimi`} value={r.end} onChange={(e) => update(day, (x) => x.map((y, j) => (j === i ? { ...y, end: e.target.value } : y)))} className="h-9 rounded-lg border border-line-strong bg-surface px-2" />
                  <button type="button" aria-label="Hiq periudhën" onClick={() => update(day, (x) => x.filter((_, j) => j !== i))} className="grid size-8 place-items-center rounded-lg text-ink-soft hover:bg-danger-bg hover:text-danger-fg">
                    ×
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => update(day, (x) => [...x, x.length ? { start: "14:00", end: "17:00" } : { start: "09:00", end: "17:00" }])} className="text-sm font-medium text-brand-700 hover:underline">
                + Shto periudhë
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error ? (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      <Button className="mt-4" busy={busy} onClick={save}>
        Ruaj orarin
      </Button>
    </Card>
  );
}

function TimeOffEditor({ staffId }: { staffId: number }) {
  const { clinic } = useSession();
  const zone = clinic.timezone;
  const toast = useToast();
  const list = useLoad(() => api.get<{ timeOff: Array<{ id: number; startsAt: string; endsAt: string; reason: string | null }> }>(`/api/staff/${staffId}/time-off`), [staffId]);
  const [form, setForm] = useState({ from: today(zone), to: today(zone), reason: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Whole days: from the start of the first day to the start of the day after the last.
      const startsAt = zonedInstant(form.from, "00:00", zone);
      const endsAt = new Date(zonedInstant(form.to, "23:59", zone).getTime() + 60000);
      await api.post(`/api/staff/${staffId}/time-off`, { startsAt, endsAt, reason: form.reason });
      toast("Pushimi u shtua");
      setForm((f) => ({ ...f, reason: "" }));
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ruajtja dështoi.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    await api.del(`/api/time-off/${id}`).catch((err: unknown) => toast(err instanceof Error ? err.message : "Gabim.", "danger"));
    list.reload();
  }

  return (
    <Card className="p-5">
      <h2 className="font-display text-xl font-semibold tracking-tight">Ditë pushimi</h2>
      <p className="mt-1 mb-4 text-sm text-ink-soft">Në këto ditë nuk caktohen termine. Terminet që ekzistojnë duhen anuluar së pari, që pacientët të njoftohen.</p>
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
        <Field label="Nga">{(p) => <Input {...p} type="date" required value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value, to: e.target.value > form.to ? e.target.value : form.to })} />}</Field>
        <Field label="Deri">{(p) => <Input {...p} type="date" required min={form.from} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
        <Field label="Arsyeja (opsionale)">{(p) => <Input {...p} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="p.sh. Pushim vjetor" />}</Field>
        <Button type="submit" busy={busy}>
          Shto
        </Button>
      </form>
      {error ? (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      {list.data?.timeOff.length ? (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {list.data.timeOff.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
              <span className="first-letter:uppercase">
                {fmtDateTime(t.startsAt, zone)} → {fmtDateTime(t.endsAt, zone)}
                {t.reason ? <span className="text-ink-soft"> · {t.reason}</span> : null}
              </span>
              <button type="button" onClick={() => void remove(t.id)} className="font-medium text-danger-fg hover:underline">
                Hiq
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ---- clinic ----------------------------------------------------------------------------------------------

function ClinicSettings() {
  const { clinic } = useSession();
  const { refresh } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    name: clinic.name,
    phone: clinic.phone ?? "",
    address: clinic.address ?? "",
    bookingNoticeHours: String(clinic.bookingNoticeHours),
    cancelNoticeHours: String(clinic.cancelNoticeHours),
    slotStepMinutes: String(clinic.slotStepMinutes),
    bookingHorizonDays: String(clinic.bookingHorizonDays),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch("/api/clinic", {
        name: form.name,
        phone: form.phone || null,
        address: form.address || null,
        bookingNoticeHours: Number(form.bookingNoticeHours),
        cancelNoticeHours: Number(form.cancelNoticeHours),
        slotStepMinutes: Number(form.slotStepMinutes),
        bookingHorizonDays: Number(form.bookingHorizonDays),
      });
      await refresh();
      toast("Cilësimet u ruajtën");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ruajtja dështoi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <Card className="space-y-4 p-5">
        <h2 className="font-display text-xl font-semibold tracking-tight">Të dhënat e klinikës</h2>
        <Field label="Emri">{(p) => <Input {...p} required value={form.name} onChange={set("name")} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Telefoni" hint="U shfaqet pacientëve për termine urgjente.">
            {(p) => <Input {...p} type="tel" value={form.phone} onChange={set("phone")} />}
          </Field>
          <Field label="Adresa">{(p) => <Input {...p} value={form.address} onChange={set("address")} />}</Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-display text-xl font-semibold tracking-tight">Rregullat e termineve online</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rezervimi online mbyllet (orë përpara)" hint="Pacienti nuk mund të caktojë termin më afër se kaq orë nga tani.">
            {(p) => <Input {...p} type="number" min={0} max={720} required value={form.bookingNoticeHours} onChange={set("bookingNoticeHours")} />}
          </Field>
          <Field label="Njoftimi për anulim (orë përpara)" hint="Sa orë para terminit i premtoni pacientit ta njoftoni nëse e anuloni.">
            {(p) => <Input {...p} type="number" min={0} max={720} required value={form.cancelNoticeHours} onChange={set("cancelNoticeHours")} />}
          </Field>
          <Field label="Hapi i orareve" hint="Çdo sa minuta fillon një orar i mundshëm.">
            {(p) => (
              <Select {...p} value={form.slotStepMinutes} onChange={set("slotStepMinutes")}>
                {[10, 15, 20, 30, 60].map((m) => (
                  <option key={m} value={m}>
                    {m} minuta
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Sa ditë përpara mund të rezervohet">{(p) => <Input {...p} type="number" min={1} max={365} required value={form.bookingHorizonDays} onChange={set("bookingHorizonDays")} />}</Field>
        </div>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" busy={busy}>
        Ruaj cilësimet
      </Button>
    </form>
  );
}

// ---- staff -----------------------------------------------------------------------------------------------

function StaffSettings() {
  const { user } = useSession();
  const toast = useToast();
  const staff = useLoad(() => api.get<{ staff: Staff[] }>("/api/staff"), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", password: "", role: "dentist", isBookable: true });
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api.post("/api/staff", form);
      toast("Përdoruesi u shtua");
      setAdding(false);
      setForm({ fullName: "", email: "", password: "", role: "dentist", isBookable: true });
      staff.reload();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError("Shtimi dështoi.");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    try {
      await api.patch(`/api/staff/${id}`, body);
      staff.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Gabim.", "danger");
    }
  }

  if (staff.loading && !staff.data) return <Loading />;
  if (staff.error) return <LoadError message={staff.error} onRetry={staff.reload} />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-ink-soft">Çdo stomatolog kyçet me llogarinë e vet dhe sheh vetëm pacientët e tij.</p>
        <Button onClick={() => setAdding(true)}>
          <span aria-hidden="true">+</span> Shto përdorues
        </Button>
      </div>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {staff.data!.staff.map((s) => (
            <li key={s.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span className={s.isActive ? "" : "text-ink-faint line-through"}>{s.fullName}</span>
                  <Badge tone={s.role === "admin" ? "info" : "neutral"}>{s.role === "admin" ? "Administrator" : "Stomatolog"}</Badge>
                  {!s.isActive ? <Badge tone="danger">Çaktivizuar</Badge> : null}
                  {s.id === user.id ? <Badge>Ju</Badge> : null}
                </p>
                <p className="text-sm break-all text-ink-soft sm:truncate">{s.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-brand-700" checked={s.isBookable} disabled={!s.isActive} onChange={(e) => void patch(s.id, { isBookable: e.target.checked })} />
                  Pranon termine
                </label>
                {s.id !== user.id ? (
                  <Button variant="secondary" size="sm" onClick={() => void patch(s.id, { isActive: !s.isActive })}>
                    {s.isActive ? "Çaktivizo" : "Aktivizo"}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Përdorues i ri"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Mbyll
            </Button>
            <Button busy={busy} onClick={add}>
              Shto
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field label="Emri dhe mbiemri" error={fields.fullName}>
            {(p) => <Input {...p} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="p.sh. Dr. Besnik Gashi" />}
          </Field>
          <Field label="Email (me të kyçet)" error={fields.email}>
            {(p) => <Input {...p} type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
          </Field>
          <Field label="Fjalëkalimi fillestar" error={fields.password} hint="Të paktën 8 shkronja. Jepjani personit drejtpërdrejt.">
            {(p) => <Input {...p} type="text" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
          </Field>
          <Field label="Roli">
            {(p) => (
              <Select {...p} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="dentist">Stomatolog — sheh vetëm pacientët e vet</option>
                <option value="admin">Administrator — sheh dhe menaxhon gjithë klinikën</option>
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand-700" checked={form.isBookable} onChange={(e) => setForm({ ...form, isBookable: e.target.checked })} />
            Pranon termine (është stomatolog)
          </label>
        </div>
      </Modal>
    </>
  );
}

// ---- services --------------------------------------------------------------------------------------------

function ServiceSettings() {
  const toast = useToast();
  const services = useLoad(() => api.get<{ services: Service[] }>("/api/services"), []);
  const [form, setForm] = useState({ name: "", durationMinutes: "30" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/services", { name: form.name, durationMinutes: Number(form.durationMinutes) });
      setForm({ name: "", durationMinutes: "30" });
      toast("Shërbimi u shtua");
      services.reload();
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields.name ?? err.fields.durationMinutes ?? err.message) : "Shtimi dështoi.");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    try {
      await api.patch(`/api/services/${id}`, body);
      services.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Gabim.", "danger");
    }
  }

  if (services.loading && !services.data) return <Loading />;
  if (services.error) return <LoadError message={services.error} onRetry={services.reload} />;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="font-display text-xl font-semibold tracking-tight">Shërbim i ri</h2>
        <p className="mt-1 mb-4 text-sm text-ink-soft">Kohëzgjatja vendos sa vend zë termini në kalendar.</p>
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <Field label="Emri">{(p) => <Input {...p} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="p.sh. Zbardhim dhëmbësh" />}</Field>
          <Field label="Minuta">{(p) => <Input {...p} type="number" min={5} max={480} step={5} required value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} />}</Field>
          <Button type="submit" busy={busy}>
            Shto
          </Button>
        </form>
        {error ? (
          <div className="mt-3">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
      </Card>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {services.data!.services.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
              <span>
                <span className={`font-medium ${s.isActive ? "" : "text-ink-faint line-through"}`}>{s.name}</span>
                <span className="ml-2 text-sm text-ink-soft">{fmtDuration(s.durationMinutes)}</span>
              </span>
              <Button variant="secondary" size="sm" onClick={() => void patch(s.id, { isActive: !s.isActive })}>
                {s.isActive ? "Çaktivizo" : "Aktivizo"}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
