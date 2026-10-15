import { Link } from "react-router-dom";
import { Mark } from "./Home";

// An address that leads nowhere. It says so, and offers the two places a visitor most likely wanted, instead
// of silently showing the home page under a wrong address.
export function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-5 py-16">
      <div className="w-full max-w-md text-center">
        <Link to="/" className="tap inline-flex items-center gap-3" aria-label="Rrënja Dental, faqja kryesore">
          <Mark className="size-10" />
          <span className="text-lg font-bold tracking-tight">Rrënja Dental</span>
        </Link>
        <p className="mt-10 text-sm font-semibold tracking-[0.14em] text-brand-700 uppercase">Gabim 404</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">Kjo faqe nuk ekziston</h1>
        <p className="mt-3 text-ink-soft">Adresa mund të jetë shkruar gabim, ose faqja është zhvendosur.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/rezervo" className="tap inline-flex h-12 items-center rounded-xl bg-brand-700 px-6 font-semibold text-white hover:bg-brand-600">
            Cakto termin
          </Link>
          <Link to="/" className="tap inline-flex h-12 items-center rounded-xl border border-line-strong bg-surface px-6 font-semibold hover:bg-brand-50">
            Faqja kryesore
          </Link>
        </div>
      </div>
    </main>
  );
}
