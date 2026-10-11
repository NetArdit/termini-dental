import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api, type Service } from "../lib/api";
import { addDays, dayChip, fmtDateLong, fmtDateTime, fmtDuration, fmtTime } from "../lib/format";
import { Button, Card, Field, Input, LoadError, Loading, Notice, useLoad } from "../ui";

// The page a patient sees: service, dentist, day and time, their details, the cancellation notice, done.
// Everything shown here is re-checked by the server when the booking is sent.

interface PublicClinic {
  clinic: { slug: string; name: string; phone: string | null; address: string | null; timezone: string; bookingNoticeHours: number; cancelNoticeHours: number };
  services: Service[];
  dentists: Array<{ id: number; fullName: string }>;
  firstDate: string;
  lastDate: string;
}

interface DaySlots {
  date: string;
  slots: string[];
}

const WINDOW = 7;

function Step({ n, title, done, children }: { n: number; title: string; done?: string | null; children?: ReactNode }) {
  return (
    <section className="border-t border-line py-6 first:border-t-0 first:pt-0">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? "bg-brand-700 text-white" : "bg-brand-100 text-brand-700"}`}>{n}</span>
        <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
        {/* What was chosen, in full: under the title on a phone, beside it on a wider screen. */}
        {done ? <span className="w-full pl-10 text-sm text-ink-soft sm:ml-auto sm:w-auto sm:pl-0">{done}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-xl border px-4 py-3 text-left transition-colors ${selected ? "border-brand-600 bg-brand-50 ring-1 ring-brand-600" : "border-line-strong bg-surface hover:border-brand-200 hover:bg-brand-50/50"}`}
    >
      {children}
    </button>
  );
}

export function Book() {
  const { slug = "" } = useParams();
  const page = useLoad(() => api.get<PublicClinic>(`/api/public/clinics/${encodeURIComponent(slug)}`), [slug]);

  const [serviceId, setServiceId] = useState<number | null>(null);
  /** undefined: not chosen yet. null: any dentist. */
  const [dentistId, setDentistId] = useState<number | null | undefined>(undefined);
  const [from, setFrom] = useState<string | null>(null);
  const [days, setDays] = useState<DaySlots[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  /** Bumped to fetch the free times again without changing the selection. */
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [date, setDate] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", acceptNotice: false });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ token: string; startsAt: string; emailStatus: string } | null>(null);

  const data = page.data;
  const zone = data?.clinic.timezone;
  const service = data?.services.find((s) => s.id === serviceId) ?? null;
  // A clinic with one dentist does not ask the patient to choose.
  const oneDentist = data?.dentists.length === 1;
  const effectiveDentist = oneDentist ? data!.dentists[0]!.id : dentistId;
  const dentistChosen = effectiveDentist !== undefined;

  useEffect(() => {
    if (data && !from) setFrom(data.firstDate);
  }, [data, from]);

  // Load one week of free times whenever the service, dentist or week changes.
  useEffect(() => {
    if (!data || !serviceId || !dentistChosen || !from) return;
    let current = true;
    setDays(null);
    setSlotsError(null);
    const dentist = effectiveDentist ? `&dentistId=${effectiveDentist}` : "";
    api.get<{ days: DaySlots[] }>(`/api/public/clinics/${encodeURIComponent(slug)}/slots?serviceId=${serviceId}${dentist}&from=${from}&days=${WINDOW}`).then(
      (res) => {
        if (!current) return;
        setDays(res.days);
        // Keep the chosen day if it is still in view; otherwise open the first day that has a free time.
        setDate((d) => (d && res.days.some((x) => x.date === d) ? d : (res.days.find((x) => x.slots.length)?.date ?? null)));
      },
      (err: unknown) => current && setSlotsError(err instanceof Error ? err.message : "Gabim."),
    );
    return () => {
      current = false;
    };
  }, [data, slug, serviceId, effectiveDentist, dentistChosen, from, slotsVersion]);

  const daySlots = useMemo(() => days?.find((d) => d.date === date)?.slots ?? [], [days, date]);

  if (page.loading) return <Shell><Loading /></Shell>;
  if (page.error || !data) {
    return (
      <Shell>
        <LoadError message={page.error ?? "Klinika nuk u gjet."} onRetry={page.reload} />
      </Shell>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!service || !startsAt) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await api.post<{ token: string; startsAt: string; emailStatus: string }>(`/api/public/clinics/${encodeURIComponent(slug)}/book`, {
        serviceId: service.id,
        dentistId: effectiveDentist ?? null,
        startsAt,
        ...form,
      });
      setDone(res);
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
        // Someone else took the time meanwhile: show the day again with what is still free.
        if (err.status === 409) {
          setStartsAt(null);
          setSlotsVersion((v) => v + 1);
        }
      } else setError("Rezervimi dështoi.");
    } finally {
      setBusy(false);
    }
  }

  const { clinic } = data;

  if (done) {
    return (
      <Shell clinic={clinic}>
        <Card className="animate-rise p-6 sm:p-8">
          <div className="mb-4 grid size-12 place-items-center rounded-full bg-ok-bg text-ok-fg">
            <svg viewBox="0 0 20 20" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 10.500l4 4 8-9" />
            </svg>
          </div>
          {/* The clinic's name above is the page's one main heading; this is the next level down. */}
          <h2 className="font-display text-2xl font-semibold tracking-tight">Termini u caktua</h2>
          <p className="mt-2 text-lg">{fmtDateTime(done.startsAt, zone)}</p>
          <p className="text-ink-soft">
            {service?.name} · {clinic.name}
          </p>
          <div className="mt-6 space-y-3">
            {done.emailStatus !== "accepted" ? (
              <Notice tone="warn" title="Emaili i konfirmimit nuk u dërgua">
                Termini juaj është i caktuar, por emaili nuk u dërgua dot. Ruajeni linkun më poshtë.
              </Notice>
            ) : (
              <Notice tone="info">Ju kemi dërguar një email me të dhënat e terminit dhe me linkun për ta anuluar nëse nuk mund të vini. Nëse nuk e gjeni, shikoni edhe te mesazhet e padëshiruara; linku është edhe më poshtë.</Notice>
            )}
            <Notice tone="warn" title="Mbani mend">
              Nëse paraqitet ndonjë pengesë, klinika mund ta anulojë terminin. Në atë rast ju njoftojmë me email, zakonisht të paktën {clinic.cancelNoticeHours} orë përpara.
            </Notice>
          </div>
          <Link to={`/termin#${done.token}`}className="mt-6 inline-block font-medium text-brand-700 underline underline-offset-2">
            Shiko ose anulo terminin
          </Link>
        </Card>
      </Shell>
    );
  }

  const noDentists = data.dentists.length === 0 || data.services.length === 0;

  return (
    <Shell clinic={clinic}>
      <Notice tone="info">
        Terminet online caktohen të paktën <strong>{clinic.bookingNoticeHours} orë përpara</strong>.{clinic.phone ? <> Për termin më të shpejtë telefononi në <a className="font-semibold underline" href={`tel:${clinic.phone}`}>{clinic.phone}</a>.</> : " Për termin më të shpejtë telefononi klinikën."}
      </Notice>

      {noDentists ? (
        <Card className="mt-6 p-8 text-center text-ink-soft">Kjo klinikë nuk pranon ende termine online.</Card>
      ) : (
        <Card className="mt-6 p-5 sm:p-8">
          <Step n={1} title="Zgjidhni shërbimin" done={service ? service.name : null}>
            <div className="grid gap-2 sm:grid-cols-2">
              {data.services.map((s) => (
                <Choice
                  key={s.id}
                  selected={s.id === serviceId}
                  onClick={() => {
                    setServiceId(s.id);
                    setStartsAt(null);
                  }}
                >
                  <span className="block font-medium">{s.name}</span>
                  <span className="text-sm text-ink-soft">{fmtDuration(s.durationMinutes)}</span>
                </Choice>
              ))}
            </div>
          </Step>

          {service && !oneDentist ? (
            <Step n={2} title="Zgjidhni stomatologun" done={dentistId === undefined ? null : dentistId === null ? "Kushdo" : data.dentists.find((d) => d.id === dentistId)?.fullName}>
              <div className="grid gap-2 sm:grid-cols-2">
                <Choice
                  selected={dentistId === null}
                  onClick={() => {
                    setDentistId(null);
                    setStartsAt(null);
                  }}
                >
                  <span className="block font-medium">Kushdo që është i lirë</span>
                  <span className="text-sm text-ink-soft">Më shumë orare në dispozicion</span>
                </Choice>
                {data.dentists.map((d) => (
                  <Choice
                    key={d.id}
                    selected={dentistId === d.id}
                    onClick={() => {
                      setDentistId(d.id);
                      setStartsAt(null);
                    }}
                  >
                    <span className="block font-medium">{d.fullName}</span>
                    <span className="text-sm text-ink-soft">Stomatolog</span>
                  </Choice>
                ))}
              </div>
            </Step>
          ) : null}

          {service && dentistChosen ? (
            <Step n={oneDentist ? 2 : 3} title="Zgjidhni ditën dhe orën" done={startsAt ? fmtDateTime(startsAt, zone) : null}>
              {/* The arrows sit above the week, so the seven days share the whole width of a phone. */}
              <div className="mb-2 flex items-center justify-between gap-2">
                <Button variant="secondary" size="sm" aria-label="Java e kaluar" disabled={!from || from <= data.firstDate} onClick={() => setFrom((f) => (f ? (addDays(f, -WINDOW) < data.firstDate ? data.firstDate : addDays(f, -WINDOW)) : f))}>
                  ←
                </Button>
                <span className="text-sm text-ink-soft">
                  {(() => {
                    const first = dayChip(from ?? data.firstDate);
                    const last = dayChip(addDays(from ?? data.firstDate, WINDOW - 1));
                    return `${first.day} ${first.month} – ${last.day} ${last.month}`;
                  })()}
                </span>
                <Button variant="secondary" size="sm" aria-label="Java tjetër" disabled={!from || addDays(from, WINDOW) > data.lastDate} onClick={() => setFrom((f) => (f ? addDays(f, WINDOW) : f))}>
                  →
                </Button>
              </div>
              <div>
                <div className="grid grid-cols-7 gap-1.5">
                  {(days ?? Array.from({ length: WINDOW }, (_, i) => ({ date: addDays(from ?? data.firstDate, i), slots: [] as string[] }))).map((d) => {
                    const chip = dayChip(d.date);
                    const free = d.slots.length > 0;
                    const selected = d.date === date;
                    return (
                      <button
                        key={d.date}
                        type="button"
                        disabled={!free}
                        aria-pressed={selected}
                        aria-label={`${fmtDateLong(d.date)}${free ? "" : ", pa orare të lira"}`}
                        onClick={() => {
                          setDate(d.date);
                          setStartsAt(null);
                        }}
                        className={`rounded-xl border px-1 py-2 text-center transition-colors ${selected ? "border-brand-700 bg-brand-700 text-white" : free ? "border-line-strong bg-surface hover:border-brand-200 hover:bg-brand-50" : "border-transparent bg-paper text-ink-faint"}`}
                      >
                        <span className="block text-xs">{chip.weekday}</span>
                        <span className="block text-lg leading-tight font-semibold">{chip.day}</span>
                        <span className="block text-xs">{chip.month}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4 min-h-24">
                {slotsError ? (
                  <Notice tone="danger">{slotsError}</Notice>
                ) : !days ? (
                  <Loading label="Duke kërkuar oraret e lira…" />
                ) : !date ? (
                  <p className="py-6 text-center text-ink-soft">Nuk ka orare të lira këtë javë. Provoni javën tjetër.</p>
                ) : (
                  <>
                    <p className="mb-2 text-sm text-ink-soft">{fmtDateLong(date)}</p>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                      {daySlots.map((s) => (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={s === startsAt}
                          onClick={() => setStartsAt(s)}
                          className={`h-10 rounded-lg border text-sm font-medium tabular-nums transition-colors ${s === startsAt ? "border-brand-700 bg-brand-700 text-white" : "border-line-strong bg-surface hover:border-brand-200 hover:bg-brand-50"}`}
                        >
                          {fmtTime(s, zone)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Step>
          ) : null}

          {service && startsAt ? (
            <Step n={oneDentist ? 3 : 4} title="Të dhënat tuaja">
              <form onSubmit={submit} className="space-y-4" noValidate>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Field label="Emri dhe mbiemri" error={fields.fullName}>
                      {(p) => <Input {...p} required autoComplete="name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />}
                    </Field>
                  </div>
                  <Field label="Telefoni" error={fields.phone}>
                    {(p) => <Input {...p} type="tel" required autoComplete="tel" placeholder="044 123 456" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}
                  </Field>
                  <Field label="Email" error={fields.email} hint="Këtu ju dërgojmë konfirmimin.">
                    {(p) => <Input {...p} type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
                  </Field>
                </div>

                {/* Owner's rule 1: the patient sees this before the appointment exists, and must accept it. */}
                <div className="rounded-xl bg-warn-bg p-4 text-warn-fg">
                  <p className="font-semibold">Para se të konfirmoni</p>
                  <p className="mt-1 text-sm leading-relaxed">
                    Nëse paraqitet ndonjë pengesë, klinika mund ta anulojë terminin tuaj. Në atë rast ju njoftojmë me email, zakonisht <strong>të paktën {clinic.cancelNoticeHours} orë para terminit</strong>; në raste urgjente njoftimi mund të vijë më vonë.
                  </p>
                  <label className="mt-3 flex items-start gap-3 text-sm font-medium">
                    <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={form.acceptNotice} onChange={(e) => setForm({ ...form, acceptNotice: e.target.checked })} />
                    E kam lexuar dhe e pranoj
                  </label>
                  {fields.acceptNotice ? <p className="mt-1 text-sm font-medium text-danger-fg">{fields.acceptNotice}</p> : null}
                </div>

                {error ? <Notice tone="danger">{error}</Notice> : null}

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-50 p-4">
                  <div>
                    <p className="font-medium">{fmtDateTime(startsAt, zone)}</p>
                    <p className="text-sm text-ink-soft">
                      {service.name} · {fmtDuration(service.durationMinutes)}
                    </p>
                  </div>
                  <Button type="submit" size="lg" busy={busy} disabled={!form.acceptNotice}>
                    Konfirmo terminin
                  </Button>
                </div>
              </form>
            </Step>
          ) : null}
        </Card>
      )}
    </Shell>
  );
}

function Shell({ clinic, children }: { clinic?: PublicClinic["clinic"]; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="bg-brand-700 text-white">
        <div className="mx-auto max-w-2xl px-4 py-8">
          <p className="text-sm text-brand-100">Termine online</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{clinic?.name ?? "Klinika dentare"}</h1>
          {clinic?.address || clinic?.phone ? <p className="mt-1 text-brand-100">{[clinic.address, clinic.phone].filter(Boolean).join(" · ")}</p> : null}
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-2xl px-4 pb-10 text-center text-xs text-ink-faint">
        Mundësuar nga <Link to="/" className="underline">Termini Dental</Link>
      </footer>
    </div>
  );
}
