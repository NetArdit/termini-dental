import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { Logo } from "./Login";

// The product's front page, for clinics deciding whether to use it. It shows the patient's side of the
// product instead of only describing it, then how to start, then what each side gets.
// There is no price and no contact here: the owner has not named either. No link leads to a page that does
// not exist.

const STEPS: Array<[string, string]> = [
  ["Regjistroni klinikën", "Vendosni shërbimet, stomatologët dhe orarin e punës."],
  ["Ndani linkun", "Në rrjete sociale, në Google ose me mesazh. Pacientët e zgjedhin orën vetë."],
  ["Punoni me kalendarin", "Çdo termin, çdo raport dhe çdo kontroll i radhës në një vend."],
];

// The six things the product does, as they were on this page before, sorted by whom they serve.
const FOR_CLINIC = [
  "Çdo stomatolog me llogarinë, orarin dhe pacientët e vet; administratori sheh gjithë klinikën",
  "Raport për çdo vizitë: korrigjimet ruhen, asgjë nuk humbet",
  "Pacientët që vijnë ose telefonojnë i shtoni vetë dhe u caktoni termin në çast",
  "Online rezervohet të paktën 36 orë përpara, kështu që dita e nesërme është gjithmonë e qartë",
];
const FOR_PATIENT = [
  "Zgjedh shërbimin, stomatologun dhe orën nga telefoni, ditë e natë, pa llogari",
  "Merr konfirmim dhe një kujtesë një ditë më parë",
  "Njoftohet me email kur klinika e anulon një termin",
  "E anulon vetë terminin nga linku i tij, nëse nuk mund të vijë",
];

/** The patient's booking page, drawn small: markup only, so it can never show a screen the product lacks. */
function PhonePreview() {
  const slots = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "14:30"];
  return (
    <div aria-hidden="true" className="mx-auto w-64 rounded-[2rem] bg-brand-900 p-2.5 shadow-pop">
      <div className="overflow-hidden rounded-[1.5rem] bg-paper text-xs text-ink">
        <div className="bg-brand-700 px-4 pt-4 pb-3 text-white">
          <p className="text-brand-100">Termine online</p>
          <p className="font-display text-base font-semibold">Klinika juaj dentare</p>
        </div>
        <div className="space-y-2 p-3">
          <div className="rounded-lg border border-brand-500 bg-brand-50 px-3 py-2">
            <p className="font-semibold">Kontroll</p>
            <p className="text-ink-soft">30 min</p>
          </div>
          <div className="rounded-lg border border-line-strong bg-surface px-3 py-2">
            <p className="font-semibold">Mbushje</p>
            <p className="text-ink-soft">45 min</p>
          </div>
          <p className="pt-1 text-ink-soft">E mërkurë, 14 tetor</p>
          <div className="grid grid-cols-4 gap-1.5">
            {slots.map((s) => (
              <span key={s} className={`rounded-md border py-1.5 text-center tabular-nums ${s === "09:30" ? "border-brand-700 bg-brand-700 text-white" : "border-line-strong bg-surface"}`}>
                {s}
              </span>
            ))}
          </div>
          <p className="mt-1 rounded-lg bg-brand-700 py-2 text-center font-medium text-white">Konfirmo terminin</p>
        </div>
      </div>
    </div>
  );
}

function Checklist({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-7">
      <h3 className="font-display text-xl font-semibold tracking-tight">{title}</h3>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex gap-3 leading-relaxed">
            <svg viewBox="0 0 20 20" className="mt-1 size-4 shrink-0 text-brand-500" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 10.5l4 4 8-9" />
            </svg>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Landing() {
  const { session } = useAuth();
  return (
    <div className="min-h-dvh">
      <header className="bg-brand-700 text-white">
        <nav aria-label="Llogaria" className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
          <Logo light />
          <div className="flex items-center gap-2 text-sm font-medium">
            {session ? (
              <Link to="/app" className="tap rounded-lg bg-white px-4 py-2 text-brand-900 hover:bg-brand-50">
                Hap klinikën
              </Link>
            ) : (
              <>
                <Link to="/kycu" className="tap rounded-lg px-4 py-2 hover:bg-white/10">
                  Kyçu
                </Link>
                <Link to="/regjistrohu" className="tap rounded-lg bg-white px-4 py-2 text-brand-900 hover:bg-brand-50 max-sm:hidden">
                  Regjistro klinikën
                </Link>
              </>
            )}
          </div>
        </nav>
        <div className="mx-auto grid max-w-5xl items-center gap-10 px-4 pt-6 pb-14 md:grid-cols-[1.1fr_0.9fr] md:pt-10 md:pb-20">
          <div>
            <h1 className="font-display text-4xl leading-[1.08] font-semibold tracking-tight sm:text-5xl">Pacientët caktojnë terminin vetë. Ju shihni ditën tuaj.</h1>
            <p className="mt-5 max-w-xl text-lg text-brand-100">Faqe termineve online për klinikën tuaj dentare, raport për çdo vizitë dhe lista e pacientëve që duhet të vijnë për kontroll.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={session ? "/app" : "/regjistrohu"} className="tap justify-center rounded-xl bg-white px-6 py-3 font-semibold text-brand-900 hover:bg-brand-50 max-sm:flex-1">
                {session ? "Hap klinikën" : "Regjistro klinikën falas"}
              </Link>
              {session ? null : (
                <Link to="/kycu" className="tap justify-center rounded-xl border border-white/40 px-6 py-3 font-semibold hover:bg-white/10 max-sm:flex-1">
                  Kam llogari
                </Link>
              )}
            </div>
            <p className="mt-4 text-sm text-brand-100">Gati për 5 minuta. Pa instalim, punon në telefon dhe në kompjuter.</p>
          </div>
          <PhonePreview />
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-5xl px-4 py-14 sm:py-16">
          <h2 className="font-display text-3xl font-semibold tracking-tight">Si funksionon</h2>
          <ol className="mt-8 grid gap-5 md:grid-cols-3">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
                <span className="grid size-8 place-items-center rounded-full bg-brand-100 font-semibold text-brand-700" aria-hidden="true">
                  {i + 1}
                </span>
                <h3 className="mt-3 text-lg font-semibold">{title}</h3>
                <p className="mt-1 leading-relaxed text-ink-soft">{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y border-brand-100 bg-brand-50">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:py-16">
            <h2 className="font-display text-3xl font-semibold tracking-tight">Për klinikën dhe për pacientin</h2>
            <div className="mt-8 grid gap-5 md:grid-cols-2">
              <Checklist title="Klinika" items={FOR_CLINIC} />
              <Checklist title="Pacienti" items={FOR_PATIENT} />
            </div>
            <p className="mt-6 text-ink-soft">Pa kufi terminesh.</p>
          </div>
        </section>
      </main>

      <footer>
        <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-ink-soft">Termini Dental · Termine online për klinika dentare</div>
      </footer>
    </div>
  );
}
