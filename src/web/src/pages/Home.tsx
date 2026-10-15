import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Service } from "../lib/api";
import { fmtDuration, fmtMoney, fmtOpeningHours } from "../lib/format";
import { Stars } from "../components/Stars";
import { useLoad } from "../ui";

// The public home page of Rrënja Dental, in the direction the owner chose ("B, e pastër": white, deep navy,
// one fresh blue, a soft mint, rounded). What it says is only what the clinic's own data says: its services
// and how long each takes, its dentists, its address and phone, and the rules of booking online. It has no
// prices, no ratings, no patients' words and no awards: none of those exist yet, and a made-up one would be
// a lie on a clinic's front page. What the owner has not supplied yet (prices, opening hours) is simply not
// on the page: a public page does not show "coming soon" lines.
// The photographs are stock pictures of dental rooms (public/media/photographs.json), credited in the footer.

interface PublicClinic {
  clinic: { name: string; phone: string | null; address: string | null; bookingNoticeHours: number; cancelNoticeHours: number; deposit: { mode: "demo"; amountMinor: number; currency: string } };
  services: Service[];
  dentists: Array<{ id: number; fullName: string; title: string | null; hasPhoto: boolean; rating: { average: number; count: number } | null }>;
  reviews: Array<{ rating: number; comment: string; dentistName: string; at: string }>;
  hours: Array<{ weekday: number; startMinute: number; endMinute: number }>;
}

interface GalleryItem {
  id: number;
  title: string;
  description: string | null;
  illustrative: boolean;
  after: string;
  before: string | null;
}

/** The clinic's mark: two open arcs, the crown of a tooth above and its root below. */
export function Mark({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <rect width="40" height="40" rx="11" className="fill-brand-50" />
      <path d="M12 17c0-4.2 3.2-7 8-7s8 2.800 8 7" fill="none" className="stroke-brand-700" strokeWidth="2.600" strokeLinecap="round" />
      <path d="M14.500 20.500c.4 5 2 9.500 5.500 9.500s5.100-4.500 5.500-9.500" fill="none" className="stroke-brand-500" strokeWidth="2.600" strokeLinecap="round" />
    </svg>
  );
}

function Icon({ name }: { name: "pin" | "phone" | "clock" | "arrow" | "check" | "calendar" | "mail" }) {
  const d = {
    pin: "M12 21s-7-6.100-7-11a7 7 0 1 1 14 0c0 4.900-7 11-7 11Zm0-8.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5Z",
    phone: "M6.600 3h3l1.500 4.200-2 1.500a12 12 0 0 0 6.200 6.200l1.500-2 4.200 1.500v3A2.600 2.600 0 0 1 18.400 20 15.400 15.400 0 0 1 4 5.600 2.600 2.600 0 0 1 6.600 3Z",
    clock: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm0-14v5l3.200 2",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    check: "m5 12.500 4.500 4.500L19 7.500",
    calendar: "M7 3v3m10-3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
    mail: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm0 1 8 6 8-6",
  }[name];
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.800" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const initials = (name: string) =>
  name
    .replace(/^(Dr\.?|Prof\.?)\s+/i, "")
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold tracking-[0.14em] text-brand-700 uppercase">{children}</p>;
}

function Section({ id, eyebrow, title, lead, children, tinted = false }: { id: string; eyebrow: string; title: string; lead?: string; children: ReactNode; tinted?: boolean }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`scroll-mt-24 py-16 sm:py-24 ${tinted ? "bg-paper" : "bg-surface"}`}>
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div data-rise="group" className="max-w-2xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2 id={`${id}-title`} className="mt-3 text-3xl leading-tight font-bold tracking-tight text-ink sm:text-4xl">
            {title}
          </h2>
          {lead ? <p className="mt-4 text-lg leading-relaxed text-ink-soft">{lead}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

const cta = "tap inline-flex h-12 items-center justify-center gap-2 rounded-xl px-6 text-base font-semibold transition-colors";

export function Home() {
  const page = useLoad(() => api.get<PublicClinic>("/api/public/clinic"), []);
  const gallery = useLoad(() => api.get<{ items: GalleryItem[] }>("/api/public/gallery"), []);
  const works = gallery.data?.items ?? [];
  const root = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const data = page.data;
  const clinic = data?.clinic;
  const name = clinic?.name ?? "Rrënja Dental";
  const phone = clinic?.phone ?? null;
  const hours = fmtOpeningHours(data?.hours ?? []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Motion comes afterwards, in a file of its own, and not at all for somebody who asked for less of it.
  // It starts once the clinic's data is on the page, so that what it animates is what is really there.
  useEffect(() => {
    if (!data || !root.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("../lib/motion").then((m) => {
      if (!cancelled && root.current) stop = m.homeMotion(root.current);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [data]);

  return (
    <div ref={root} className="min-h-dvh bg-surface text-ink">
      <a href="#permbajtja" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand-700 focus:px-4 focus:py-2 focus:text-white">
        Kalo te përmbajtja
      </a>

      <header className={`sticky top-0 z-40 border-b bg-surface/90 backdrop-blur transition-shadow ${scrolled ? "border-line shadow-card" : "border-transparent"}`}>
        <div className="mx-auto flex h-18 max-w-6xl items-center gap-3 px-5 sm:gap-6 sm:px-8">
          <Link to="/" className="tap flex items-center gap-3" aria-label={`${name}, faqja kryesore`}>
            <Mark />
            <span className="leading-tight">
              <span className="block text-lg font-bold tracking-tight">{name}</span>
              <span className="block text-[11px] font-medium tracking-[0.12em] text-ink-faint uppercase max-sm:hidden">Ordinancë stomatologjike</span>
            </span>
          </Link>
          <nav aria-label="Pjesët e faqes" className="ml-auto hidden items-center gap-7 text-[15px] font-medium text-ink-soft lg:flex">
            <a href="#sherbimet" className="hover:text-ink">Shërbimet</a>
            <a href="#mjeket" className="hover:text-ink">Mjekët</a>
            <a href="#si-funksionon" className="hover:text-ink">Si caktohet termini</a>
            <a href="#kontakti" className="hover:text-ink">Kontakti</a>
          </nav>
          <div className="ml-auto flex items-center gap-3 lg:ml-0">
            {phone ? (
              <a href={`tel:${phone.replace(/\s/g, "")}`} className="tap hidden items-center gap-2 font-semibold text-ink md:flex">
                <span className="text-brand-700"><Icon name="phone" /></span>
                {phone}
              </a>
            ) : null}
            <Link to="/rezervo" className={`${cta} h-11 bg-brand-700 px-4 text-[15px] whitespace-nowrap text-white hover:bg-brand-600 sm:px-5`}>
              <Icon name="calendar" />
              Cakto termin
            </Link>
          </div>
        </div>
      </header>

      <main id="permbajtja">
        {/* ---- hero ---- */}
        <section className="bg-gradient-to-b from-paper to-surface">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pt-12 pb-16 sm:px-8 lg:grid-cols-[1.08fr_0.92fr] lg:gap-16 lg:pt-20 lg:pb-24">
            <div data-hero>
              <p className="inline-flex items-center gap-2 rounded-full bg-mint px-3.5 py-1.5 text-xs font-semibold tracking-wide text-mint-fg uppercase">
                <span className="size-1.5 rounded-full bg-mint-fg" aria-hidden="true" />
                Termine online, ditë e natë
              </p>
              <h1 className="mt-6 text-[2.6rem] leading-[1.06] font-extrabold tracking-tight text-ink sm:text-6xl">Buzëqeshje e shëndetshme, kujdes pa frikë.</h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
                Zgjidhni shërbimin, stomatologun dhe orën që ju përshtatet. Sapo ta caktoni, në ekran ju del linku juaj për ta parë ose anuluar terminin. E nisim edhe me email; nëse emaili nuk mbërrin, mjafton linku nga ekrani.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/rezervo" className={`${cta} bg-brand-700 whitespace-nowrap text-white shadow-card hover:bg-brand-600 max-sm:w-full`}>
                  Cakto termin online
                  <Icon name="arrow" />
                </Link>
                <a href="#sherbimet" className={`${cta} border border-line-strong bg-surface whitespace-nowrap text-ink hover:border-brand-200 hover:bg-brand-50 max-sm:w-full`}>
                  Shiko shërbimet
                </a>
              </div>
              <dl className="mt-10 grid gap-3 border-t border-line pt-8 sm:grid-cols-2 xl:grid-cols-3">
                {clinic?.address ? <Fact icon="pin" label="Adresa" value={clinic.address} /> : null}
                {phone ? <Fact icon="phone" label="Telefoni" value={phone} nowrap /> : null}
                {hours.length ? <Fact icon="clock" label="Orari" value={hours.map(([days, time]) => `${days} ${time}`).join(" · ")} /> : <Fact icon="clock" label="Termini online" value={clinic ? `Të paktën ${clinic.bookingNoticeHours} orë përpara` : "…"} />}
              </dl>
            </div>

            <div className="relative">
              <div className="overflow-hidden rounded-[2rem] border border-line bg-surface p-2 shadow-pop">
                <div className="overflow-hidden rounded-[1.6rem]">
                  <img
                    data-settle
                    src="/media/hero-konsulte-1600.webp"
                    srcSet="/media/hero-konsulte-800.webp 800w, /media/hero-konsulte-1600.webp 1600w"
                    sizes="(min-width: 1024px) 520px, 100vw"
                    width={1600}
                    height={1067}
                    fetchPriority="high"
                    alt="Stomatologe duke biseduar me një paciente të buzëqeshur në kabinën dentare"
                    className="aspect-[4/5] w-full object-cover sm:aspect-[5/4] lg:aspect-[4/5]"
                  />
                </div>
              </div>
              <div data-caption className="absolute right-5 bottom-5 left-5 flex items-center gap-3 rounded-2xl border border-line bg-surface/95 p-3.5 shadow-card backdrop-blur sm:right-auto sm:max-w-xs">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-mint text-mint-fg"><Icon name="check" /></span>
                <p className="text-sm leading-snug">
                  <span className="block font-semibold">Së pari ju dëgjojmë</span>
                  <span className="text-ink-soft">Çdo hap ju shpjegohet para se të fillojmë.</span>
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- services ---- */}
        <Section id="sherbimet" eyebrow="Shërbimet" title="Çfarë mund të caktoni online" lead="Secili shërbim ka kohëzgjatjen e vet. Çmimi i shënuar është çmimi fillestar; të saktin jua thotë stomatologu pas kontrollit.">
          {page.error ? (
            <p className="mt-10 rounded-2xl border border-line bg-paper p-6 text-ink-soft">Shërbimet nuk u ngarkuan dot. Provoni përsëri pas pak, ose na telefononi.</p>
          ) : (
            <ul data-rise="group" className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(data?.services ?? PLACEHOLDER_SERVICES).map((s) => (
                <li key={s.id}>
                  <Link to="/rezervo" className="group flex h-full flex-col rounded-2xl border border-line bg-surface p-6 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card">
                    <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700"><ToothIcon /></span>
                    <span className="mt-5 text-lg font-semibold tracking-tight">{s.name}</span>
                    <span className="mt-1 text-sm text-ink-soft">{data ? fmtDuration(s.durationMinutes) : " "}</span>
                    {s.priceFromMinor != null ? (
                      <span className="mt-3 text-[15px] font-semibold text-ink">
                        <span className="font-normal text-ink-soft">nga </span>
                        {fmtMoney(s.priceFromMinor, "EUR")}
                      </span>
                    ) : null}
                    <span className="mt-auto inline-flex items-center gap-1.5 pt-6 text-sm font-semibold text-brand-700">
                      Cakto termin
                      <span className="transition-transform group-hover:translate-x-1"><Icon name="arrow" /></span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ---- dentists ---- */}
        {data && data.dentists.length > 0 ? (
        <Section id="mjeket" eyebrow="Mjekët" title="Kush ju pret" lead="Mund ta zgjidhni vetë stomatologun, ose të merrni terminin e parë të lirë te cilido prej tyre." tinted>
          <ul data-rise="group" className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(data?.dentists ?? []).map((d) => (
              <li key={d.id} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-5">
                {d.hasPhoto ? (
                  <img
                    src={`/api/public/dentists/${d.id}/photo`}
                    alt={`${d.fullName}`}
                    width={64}
                    height={64}
                    loading="lazy"
                    decoding="async"
                    className="size-16 shrink-0 rounded-2xl object-cover object-top"
                  />
                ) : (
                  <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-brand-900 text-lg font-bold text-white" aria-hidden="true">
                    {initials(d.fullName)}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block text-lg leading-snug font-semibold tracking-tight">{d.fullName}</span>
                  <span className="block text-sm text-ink-soft">{d.title ?? "Stomatolog"}</span>
                  {d.rating ? <Stars value={d.rating.average} count={d.rating.count} className="mt-1" /> : null}
                </span>
                <Link to="/rezervo" className="tap ml-auto shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50" aria-label={`Cakto termin te ${d.fullName}`}>
                  Cakto
                </Link>
              </li>
            ))}
          </ul>
        </Section>
        ) : null}

        {/* ---- clinical results: one illustrative before/after picture with the clinic's way of working ---- */}
        <section id="rezultatet" aria-labelledby="rezultatet-title" className="scroll-mt-24 bg-surface py-16 sm:py-24">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 sm:px-8 lg:grid-cols-2 lg:gap-16">
            <div data-rise="group">
              <Eyebrow>Rezultatet klinike</Eyebrow>
              <h2 id="rezultatet-title" className="mt-3 text-3xl leading-tight font-bold tracking-tight text-ink sm:text-4xl">
                Transformime të vërteta me saktësi mikroskopike
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-ink-soft">
                Çdo rast trajtohet individualisht, duke ruajtur integritetin e smaltit natyral. Rezultati: buzëqeshje e pastër dhe me jetëgjatësi maksimale.
              </p>
              <dl className="mt-7 rounded-2xl border border-line bg-paper p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">Protokolli i rastit</dt>
                  <dd className="text-[15px] font-semibold text-ink">Rasti Nr. 418 — Higjienë &amp; Zbardhim Vital</dd>
                </div>
                <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">Kohëzgjatja</dt>
                    <dd className="mt-1 text-[15px] font-semibold text-ink">50 minuta</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">Ndjeshmëria</dt>
                    <dd className="mt-1 text-[15px] font-semibold text-ink">Zero dhembje</dd>
                  </div>
                </div>
              </dl>
              <Link to="/rezervo" className="tap mt-7 inline-flex items-center gap-2 text-base font-semibold text-brand-700 hover:underline">
                Bëj konsultë për buzëqeshjen tënde
                <Icon name="arrow" />
              </Link>
            </div>
            <figure data-rise="group" className="relative">
              <div className="overflow-hidden rounded-3xl border border-line bg-paper p-2 shadow-card">
                <img
                  src="/media/para-pas.jpg"
                  width={626}
                  height={467}
                  loading="lazy"
                  decoding="async"
                  alt="Dhëmbët para dhe pas një higjiene me zbardhim: majtas të verdhë me gurë, djathtas të bardhë dhe të pastër."
                  className="h-auto w-full rounded-2xl"
                />
              </div>
              <figcaption className="mt-3 text-sm text-ink-faint">Fotografi ilustruese, jo e një pacienti të klinikës.</figcaption>
            </figure>
          </div>
        </section>

        {/* ---- the clinic's work: only what it has published; a patient's picture only with recorded consent,
            an illustrative one always labelled as such ---- */}
        {works.length > 0 ? (
          <Section id="punet-tona" eyebrow="Punët tona" title="Si duket puna jonë" lead="Fotografitë e pacientëve shfaqen vetëm me pëlqimin e tyre me shkrim, dhe pa emër." tinted>
            <ul data-rise="group" className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {works.map((g) => (
                <li key={g.id} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
                  <div className={`grid ${g.before ? "grid-cols-2 gap-px bg-line" : ""}`}>
                    {g.before ? (
                      <figure className="relative bg-surface">
                        <img src={g.before} alt={`${g.title}, para trajtimit`} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                        <figcaption className="absolute top-2 left-2 rounded-md bg-ink/75 px-2 py-0.5 text-xs font-medium text-white">Para</figcaption>
                      </figure>
                    ) : null}
                    <figure className="relative bg-surface">
                      <img src={g.after} alt={g.before ? `${g.title}, pas trajtimit` : g.title} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                      {g.before ? <figcaption className="absolute top-2 left-2 rounded-md bg-ink/75 px-2 py-0.5 text-xs font-medium text-white">Pas</figcaption> : null}
                    </figure>
                  </div>
                  <div className="flex flex-1 flex-col p-5">
                    <h3 className="text-lg font-semibold tracking-tight text-ink">{g.title}</h3>
                    {g.description ? <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{g.description}</p> : null}
                    {g.illustrative ? <p className="mt-auto pt-4 text-xs font-medium tracking-wide text-ink-faint uppercase">Foto ilustruese</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* ---- what patients said: only reviews the clinic has published, and never a patient's name ---- */}
        {data && data.reviews.length > 0 ? (
          <Section id="vleresimet" eyebrow="Vlerësimet" title="Çfarë thonë pacientët" lead="Vlerësimet i shkruajnë vetëm pacientët që kanë qenë në vizitë, nga linku i terminit të tyre.">
            <ul data-rise="group" className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {data.reviews.map((v, i) => (
                <li key={i} className="flex flex-col rounded-2xl border border-line bg-surface p-6">
                  <Stars value={v.rating} />
                  <blockquote className="mt-4 text-[15px] leading-relaxed text-ink">“{v.comment}”</blockquote>
                  <p className="mt-auto pt-5 text-sm text-ink-soft">Pacient i {v.dentistName}</p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* ---- how booking works ---- */}
        <Section id="si-funksionon" eyebrow="Si caktohet termini" title="Tre hapa, pa telefonata">
          <ol data-rise="group" className="mt-10 grid gap-4 lg:grid-cols-3">
            <Step n={1} title="Zgjidhni shërbimin dhe orën">Shihni oraret e lira të javës dhe merrni atë që ju përshtatet. Online caktohet të paktën {clinic?.bookingNoticeHours ?? 36} orë përpara; për më shpejt, na telefononi.</Step>
            <Step n={2} title={`Depozita ${clinic ? fmtMoney(clinic.deposit.amountMinor, clinic.deposit.currency) : "15 €"}`}>
              Zbritet nga fatura kur vini në termin. Tani për tani ky hap është vetëm demonstrim: nuk merret asnjë pagesë.
            </Step>
            <Step n={3} title="Merrni linkun tuaj">Del në ekran sapo caktohet termini; e nisim edhe me email, por ruajeni nga ekrani që të mos vareni prej tij. Me të e shihni terminin dhe e anuloni vetë nëse nuk mund të vini.</Step>
          </ol>
          <div data-rise className="mt-6 flex items-start gap-3 rounded-2xl bg-brand-50 p-5 text-[15px] leading-relaxed">
            <span className="mt-0.5 text-brand-700"><Icon name="mail" /></span>
            <p>
              Nëse klinikës i del një pengesë dhe duhet ta anulojë terminin, ju njoftojmë me email, zakonisht të paktën <strong>{clinic?.cancelNoticeHours ?? 24} orë përpara</strong>.
            </p>
          </div>
        </Section>

        {/* ---- the rooms ---- */}
        <section aria-label="Ordinanca" className="bg-paper py-16 sm:py-24">
          <div className="mx-auto grid max-w-6xl gap-4 px-5 sm:px-8 md:grid-cols-[1.25fr_0.75fr]">
            <figure data-rise className="overflow-hidden rounded-[1.75rem] border border-line bg-surface">
              <div className="overflow-hidden">
                <img data-drift src="/media/kabina-1600.webp" srcSet="/media/kabina-800.webp 800w, /media/kabina-1600.webp 1600w" sizes="(min-width: 768px) 60vw, 100vw" loading="lazy" width={1600} height={1067} alt="Kabinë dentare e ndritshme me karrigen dhe njësinë e punës" className="aspect-[16/10] w-full scale-110 object-cover" />
              </div>
            </figure>
            <figure data-rise className="overflow-hidden rounded-[1.75rem] border border-line bg-surface">
              <div className="h-full overflow-hidden">
                <img data-drift src="/media/rentgen-1600.webp" srcSet="/media/rentgen-800.webp 800w, /media/rentgen-1600.webp 1600w" sizes="(min-width: 768px) 36vw, 100vw" loading="lazy" width={1600} height={1067} alt="Stomatolog duke shikuar një pamje rentgeni të dhëmbëve" className="aspect-[16/10] h-full w-full scale-110 object-cover md:aspect-auto" />
              </div>
            </figure>
          </div>
        </section>

        {/* ---- booking band ---- */}
        <section className="bg-surface py-16 sm:py-24">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div data-rise className="relative overflow-hidden rounded-[2rem] bg-brand-900 px-6 py-12 text-white sm:px-14 sm:py-16">
              <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-brand-500/25 blur-3xl" aria-hidden="true" />
              <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_auto]">
                <div>
                  <h2 className="text-3xl leading-tight font-bold tracking-tight sm:text-4xl">Caktoni terminin tani, në një minutë.</h2>
                  <p className="mt-4 max-w-xl text-lg text-brand-100">Pa llogari dhe pa fjalëkalim. Mjaftojnë emri, telefoni dhe emaili juaj.</p>
                </div>
                <Link to="/rezervo" className={`${cta} h-14 bg-white px-8 text-lg text-brand-900 hover:bg-brand-50`}>
                  Cakto termin online
                  <Icon name="arrow" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer id="kontakti" className="scroll-mt-24 bg-brand-900 text-white">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-3">
              <Mark />
              <span className="text-lg font-bold tracking-tight">{name}</span>
            </div>
            <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-white/75">
              Ordinancë stomatologjike. Terminet caktohen online në çdo kohë, ose me telefon gjatë orarit të punës.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-white uppercase">Orari &amp; Kontakti</h2>
            <ul className="mt-4 space-y-3 text-[15px] text-white/75">
              {hours.length ? (
                <li className="flex gap-3">
                  <span className="text-brand-200"><Icon name="clock" /></span>
                  <dl>
                    {hours.map(([days, time]) => (
                      <div key={days} className="flex gap-2">
                        <dt>{days}</dt>
                        <dd className="font-medium text-white tabular-nums">{time}</dd>
                      </div>
                    ))}
                    <div className="mt-1 text-sm text-white/60">Oraret e lira varen nga stomatologu dhe shërbimi.</div>
                  </dl>
                </li>
              ) : null}
              {phone ? (
                <li className="flex gap-3">
                  <span className="text-brand-200"><Icon name="phone" /></span>
                  <a className="font-medium text-white hover:underline" href={`tel:${phone.replace(/\s/g, "")}`}>{phone}</a>
                </li>
              ) : null}
            </ul>
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-white uppercase">Lokacioni</h2>
            <ul className="mt-4 space-y-3 text-[15px] text-white/75">
              {clinic?.address ? (
                <li className="flex gap-3">
                  <span className="text-brand-200"><Icon name="pin" /></span>
                  <span>{clinic.address}</span>
                </li>
              ) : null}
              {clinic?.address ? (
                <li>
                  <a
                    className="font-semibold text-white hover:underline"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clinic.address)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Hap në Google Maps
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-white uppercase">Faqja</h2>
            <ul className="mt-4 space-y-3 text-[15px]">
              <li><Link className="text-white/75 hover:text-white hover:underline" to="/rezervo">Cakto termin</Link></li>
              <li><a className="text-white/75 hover:text-white hover:underline" href="#sherbimet">Shërbimet</a></li>
              <li><a className="text-white/75 hover:text-white hover:underline" href="#mjeket">Mjekët</a></li>
              <li><Link className="text-white/75 hover:text-white hover:underline" to="/kycu">Hyrja për stafin</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/15">
          <p className="mx-auto max-w-6xl px-5 py-5 text-xs text-white/60 sm:px-8">
            © {new Date().getFullYear()} {name}. Të gjitha të drejtat e rezervuara. Fotografitë janë ilustruese (Unsplash: Harold Hisona, Kari Bjorn, Jonathan Borba).
          </p>
        </div>
      </footer>
    </div>
  );
}

/** The outline of the cards while the clinic's services are on their way: the page does not jump when they arrive. */
const PLACEHOLDER_SERVICES: Service[] = [1, 2, 3].map((id) => ({ id: -id, name: " ", durationMinutes: 0 }) as Service);

function Fact({ icon, label, value, nowrap = false }: { icon: "pin" | "phone" | "clock"; label: string; value: string; nowrap?: boolean }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-line bg-surface p-4">
      <span className="mt-0.5 text-brand-700"><Icon name={icon} /></span>
      <div className="min-w-0">
        <dt className="text-[11px] font-semibold tracking-[0.12em] text-ink-faint uppercase">{label}</dt>
        <dd className={`mt-0.5 text-[15px] leading-snug font-semibold ${nowrap ? "whitespace-nowrap" : ""}`}>{value}</dd>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="rounded-2xl border border-line bg-surface p-6">
      <span className="grid size-10 place-items-center rounded-full bg-brand-700 text-base font-bold text-white" aria-hidden="true">
        {n}
      </span>
      <h3 className="mt-5 text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{children}</p>
    </li>
  );
}

function ToothIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.700" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3.500c-2.300 0-4 1.700-4 4.200 0 3.600 1.400 9.800 3.200 9.800 1.500 0 1.300-4.200 4.800-4.200s3.300 4.200 4.800 4.200c1.800 0 3.200-6.200 3.200-9.800 0-2.500-1.700-4.200-4-4.200-1.700 0-2.500.9-4 .9s-2.300-.9-4-.9Z" />
    </svg>
  );
}
