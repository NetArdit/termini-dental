import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, type Service } from "../lib/api";
import { addDays, dayChip, fmtDateLong, fmtDateTime, fmtDuration, fmtMoney, fmtTime } from "../lib/format";
import { BRAND_NAME, brandOf, cardProblems, cvcLength, digitsOf, formatExpiry, formatNumber, type CardField, type CardProblem, type CardValues } from "../lib/card";
import { Button, Card, Field, Input, LoadError, Loading, Notice, useLoad } from "../ui";

const EMPTY_CARD: CardValues = { number: "", name: "", expiry: "", cvc: "" };
/** The one number this demonstration accepts: the test number card schemes publish for forms like this one. */
const TEST_CARD = "4242424242424242";
const TEST_CARD_SHOWN = "4242 4242 4242 4242";
const ONLY_TEST_CARD = `Ky është demonstrim: pranohet vetëm numri i provës ${TEST_CARD_SHOWN}.`;
/** What the form says about each field, in the words a patient reads. */
const CARD_MESSAGE: Record<CardField, Partial<Record<CardProblem, string>>> = {
  "card.number": { required: "Shkruani numrin e kartës.", invalid: "Numri i kartës nuk është i saktë." },
  "card.name": { required: "Shkruani emrin siç është në kartë.", invalid: "Emri nuk duket i saktë." },
  "card.expiry": { required: "Shkruani muajin dhe vitin.", invalid: "Shkruajeni si MM/VV.", expired: "Kjo kartë ka skaduar." },
  "card.cvc": { required: "Shkruani kodin e sigurisë.", invalid: "Kodi nuk është i saktë." },
};

/**
 * The deposit, as a demonstration. It says so before the first field, in plain words: no payment is taken
 * and what is typed stays on this device. The fields behave like a real form's (grouping of the number, the
 * scheme recognised, the date and the code checked) so that the step looks as it will when a bank is
 * connected. Browsers are told not to offer saved cards here: a real card has no business in a demonstration.
 */
function DepositStep({ amount, card, errors, onChange, onUseTestCard }: { amount: string; card: CardValues; errors: Partial<Record<CardField, string>>; onChange: (card: CardValues) => void; onUseTestCard: () => void }) {
  const brand = brandOf(card.number);
  return (
    <fieldset className="rounded-xl border border-line-strong p-4">
      <legend className="px-1 font-semibold">Depozita {amount}</legend>
      <Notice tone="warn" title="Ky është demonstrim: nuk merret asnjë pagesë">
        Kështu do të duket pagesa e depozitës kur klinika të lidhet me bankën. Tani për tani asgjë nuk paguhet dhe ajo që shkruani këtu nuk dërgohet e nuk ruhet askund. Mos shkruani një kartë të vërtetë: pranohet vetëm numri i provës <strong className="tabular-nums">{TEST_CARD_SHOWN}</strong>, me çfarëdo date në të ardhmen dhe çfarëdo kodi.
      </Notice>
      <div className="mt-3">
        <Button type="button" variant="secondary" size="sm" onClick={onUseTestCard}>
          Plotëso me kartën e provës
        </Button>
      </div>
      <p className="mt-3 text-sm text-ink-soft">
        Depozita zbritet nga fatura kur vini në termin. Nëse nuk paraqiteni pa e anuluar terminin, ajo mbetet te klinika.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Numri i kartës" error={errors["card.number"]} hint={BRAND_NAME[brand] || undefined}>
            {(p) => <Input {...p} inputMode="numeric" autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" placeholder="4242 4242 4242 4242" className="tabular-nums" value={card.number} onChange={(e) => onChange({ ...card, number: formatNumber(e.target.value) })} />}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Emri në kartë" error={errors["card.name"]}>
            {(p) => <Input {...p} autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" value={card.name} onChange={(e) => onChange({ ...card, name: e.target.value })} />}
          </Field>
        </div>
        <Field label="Skadon (MM/VV)" error={errors["card.expiry"]}>
          {(p) => <Input {...p} inputMode="numeric" autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" placeholder="12/29" className="tabular-nums" value={card.expiry} onChange={(e) => onChange({ ...card, expiry: formatExpiry(e.target.value) })} />}
        </Field>
        <Field label="Kodi i sigurisë" error={errors["card.cvc"]} hint={`${cvcLength(brand)} shifra`}>
          {(p) => <Input {...p} inputMode="numeric" autoComplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" type="password" maxLength={cvcLength(brand)} className="tabular-nums" value={card.cvc} onChange={(e) => onChange({ ...card, cvc: e.target.value.replace(/\D/g, "") })} />}
        </Field>
      </div>
    </fieldset>
  );
}

/** A random UUID (version 4). `crypto.randomUUID` where the browser has it; the same from random bytes where not. */
function newAttemptKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The page a patient sees: service, dentist, day and time, their details, the cancellation notice, done.
// Everything shown here is re-checked by the server when the booking is sent.

interface PublicClinic {
  clinic: { deposit: { mode: "demo"; amountMinor: number; currency: string }; name: string; phone: string | null; address: string | null; timezone: string; bookingNoticeHours: number; cancelNoticeHours: number };
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
  const page = useLoad(() => api.get<PublicClinic>("/api/public/clinic"), []);

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
  // The card of the deposit step. It lives in this page's memory only: it is never put into a request, into
  // the browser's storage or into the address, and it is emptied as soon as the booking is made.
  const [card, setCard] = useState<CardValues>(EMPTY_CARD);
  const [cardErrors, setCardErrors] = useState<Partial<Record<CardField, string>>>({});
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
    api.get<{ days: DaySlots[] }>(`/api/public/clinic/slots?serviceId=${serviceId}${dentist}&from=${from}&days=${WINDOW}`).then(
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
  }, [data, serviceId, effectiveDentist, dentistChosen, from, slotsVersion]);

  // The name of this attempt to book. It stays the same for as long as what is asked for stays the same, so
  // pressing the button again after an answer that never arrived is the same booking to the server, not a
  // second one. Change the time, the dentist or the details, and it is a new attempt with a new name.
  const attemptKey = useMemo(
    () => newAttemptKey(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serviceId, dentistId, startsAt, form.fullName, form.phone, form.email],
  );
  const daySlots = useMemo(() => days?.find((d) => d.date === date)?.slots ?? [], [days, date]);

  if (page.loading) return <Shell><Loading /></Shell>;
  // The clinic has not been set up yet: not a failure to retry, a state to explain.
  if (page.status === 503) {
    return (
      <Shell>
        <Card className="p-8 text-center">
          <h2 className="text-xl font-semibold tracking-tight">Terminet online nuk janë hapur ende</h2>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">Klinika po përgatitet t'i pranojë terminet online. Provoni përsëri më vonë.</p>
          <p className="mt-6">
            <Link to="/" className="font-medium text-brand-700 underline underline-offset-2">
              Kthehu te faqja kryesore
            </Link>
          </p>
        </Card>
      </Shell>
    );
  }
  if (page.error || !data) {
    return (
      <Shell>
        <LoadError message={page.error ?? "Faqja nuk u ngarkua."} onRetry={page.reload} />
      </Shell>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!service || !startsAt) return;
    // The card is checked here, as a real form would check it, and goes no further than this function.
    const problems = cardProblems(card, new Date());
    const said: Partial<Record<CardField, string>> = {};
    for (const [field, problem] of Object.entries(problems) as Array<[CardField, CardProblem]>) said[field] = CARD_MESSAGE[field][problem] ?? CARD_MESSAGE[field].invalid!;
    // A demonstration has no use for anybody's own card: only the test number goes through.
    if (!said["card.number"] && digitsOf(card.number) !== TEST_CARD) said["card.number"] = ONLY_TEST_CARD;
    setCardErrors(said);
    if (Object.keys(said).length) {
      setError("Kontrolloni të dhënat e kartës.");
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await api.post<{ token: string; startsAt: string; emailStatus: string }>("/api/public/book", {
        idempotencyKey: attemptKey,
        serviceId: service.id,
        dentistId: effectiveDentist ?? null,
        startsAt,
        ...form,
        // All that is said about the payment: that this is the demonstration. Nothing of the card.
        deposit: "demo",
      });
      setCard(EMPTY_CARD);
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
        <Card className="mt-6 p-8 text-center">
          <h2 className="text-xl font-semibold tracking-tight">Terminet online nuk janë hapur ende</h2>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">{clinic.phone ? <>Deri atëherë, caktoni terminin me telefon: <a className="font-semibold text-ink underline" href={`tel:${clinic.phone}`}>{clinic.phone}</a>.</> : "Provoni përsëri më vonë."}</p>
        </Card>
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
                  <span className="text-sm text-ink-soft">
                    {fmtDuration(s.durationMinutes)}
                    {s.priceFromMinor != null ? ` · nga ${fmtMoney(s.priceFromMinor, "EUR")}` : ""}
                  </span>
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
                  <Field label="Email" error={fields.email} hint="Këtu e nisim konfirmimin.">
                    {(p) => <Input {...p} type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
                  </Field>
                </div>

                <DepositStep
                  amount={fmtMoney(clinic.deposit.amountMinor, clinic.deposit.currency)}
                  card={card}
                  errors={cardErrors}
                  onChange={(next) => {
                    // Only the test number can be typed. The first digit that departs from it is where
                    // somebody's own card would begin, whatever its length (13, 15, 16 or 19 digits): the
                    // field is emptied there and then, so no part of a real number stays in the page.
                    const typed = digitsOf(next.number);
                    if (!TEST_CARD.startsWith(typed)) {
                      setCard({ ...next, number: "", cvc: "" });
                      setCardErrors({ "card.number": ONLY_TEST_CARD });
                      return;
                    }
                    setCard(next);
                    setCardErrors({});
                  }}
                  onUseTestCard={() => {
                    setCard({ number: TEST_CARD_SHOWN, name: form.fullName.trim() || "Pacient Provë", expiry: "12/30", cvc: "123" });
                    setCardErrors({});
                  }}
                />

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
                  <p className="basis-full text-xs text-ink-soft">Depozita {fmtMoney(clinic.deposit.amountMinor, clinic.deposit.currency)} është demonstrim: nuk merret asnjë pagesë.</p>
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
        <Link to="/" className="underline">Kthehu te faqja kryesore</Link>
      </footer>
    </div>
  );
}
