import { Suspense, useState } from "react";
import { NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { Loading, useToast } from "../ui";
import { Logo } from "./Login";

// The frame of the clinic's side: navigation, who is logged in, and the gate that keeps everyone else out.

const NAV: Array<{ to: string; label: string; icon: string }> = [
  { to: "/app/kalendari", label: "Kalendari", icon: "M6 3v3M14 3v3M3.500 8h13M5 5h10a1.500 1.500 0 011.500 1.500v9A1.500 1.500 0 0115 17H5a1.500 1.500 0 01-1.500-1.500v-9A1.500 1.500 0 015 5z" },
  { to: "/app/raportet", label: "Raportet", icon: "M6 3h6l4 4v9.500A1.500 1.500 0 0114.500 18h-9A1.500 1.500 0 014 16.500v-12A1.500 1.500 0 015.500 3H6zM12 3v4h4M7 11h6M7 14h4" },
  { to: "/app/pacientet", label: "Pacientët", icon: "M10 10a3 3 0 100-6 3 3 0 000 6zM4 17c0-2.800 2.700-4.500 6-4.500s6 1.700 6 4.500" },
  { to: "/app/kontrolle", label: "Për kontroll", icon: "M10 5.500V10l3 2M17 10a7 7 0 11-14 0 7 7 0 0114 0z" },
  { to: "/app/emailat", label: "Emailat", icon: "M3.500 6.500l6.500 4.500 6.500-4.500M4.500 5h11A1.500 1.500 0 0117 6.500v7a1.500 1.500 0 01-1.500 1.500h-11A1.500 1.500 0 013 13.500v-7A1.500 1.500 0 014.500 5z" },
  { to: "/app/cilesimet", label: "Cilësimet", icon: "M4 6h7M15 6h1M4 14h1M9 14h7M13 4v4M7 12v4" },
];

export function AppLayout() {
  const { session, logout } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  if (session === undefined) return <Loading />;
  if (session === null) return <Navigate to="/kycu" replace state={{ from: location.pathname }} />;

  const bookingUrl = `${window.location.origin}/k/${session.clinic.slug}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast(bookingUrl);
    }
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="flex flex-col border-line bg-surface max-lg:border-b lg:sticky lg:top-0 lg:h-dvh lg:border-r">
        <div className="flex items-center justify-between gap-2 px-4 py-3 lg:px-5 lg:py-6">
          <Logo />
          {/* On a phone there is no sidebar foot: the clinic's booking link and the way out live here. */}
          <div className="flex items-center gap-1 lg:hidden">
            <button type="button" onClick={copyLink} aria-label="Kopjo linkun e termineve për pacientët" className="rounded-lg px-3 text-sm font-medium whitespace-nowrap text-brand-700 hover:bg-brand-50" title={bookingUrl}>
              {copied ? "U kopjua ✓" : "Kopjo linkun"}
            </button>
            <button type="button" onClick={() => void logout()} className="rounded-lg px-3 text-sm font-medium text-ink-soft hover:bg-brand-50">
              Dil
            </button>
          </div>
        </div>
        {/* All six sections are visible at once on a phone (three by two), instead of a strip that scrolls
            sideways and hides half of them. */}
        <nav aria-label="Kryesor" className="grid grid-cols-3 gap-1 px-2 pb-2 lg:flex lg:flex-col lg:px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex min-h-11 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors lg:min-h-0 lg:justify-start lg:gap-2.5 lg:px-3 ${isActive ? "bg-brand-700 text-white" : "text-ink-soft hover:bg-brand-50 hover:text-ink"}`
              }
            >
              <svg viewBox="0 0 20 20" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.500" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={item.icon} />
              </svg>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto hidden space-y-3 p-4 lg:block">
          <div className="rounded-xl bg-brand-50 p-3">
            <p className="text-xs font-medium text-brand-700">Faqja e termineve për pacientët</p>
            <p className="mt-1 truncate text-xs text-ink-soft" title={bookingUrl}>
              /k/{session.clinic.slug}
            </p>
            <div className="mt-2 flex gap-2 text-xs font-medium">
              <button type="button" onClick={copyLink} className="rounded-md bg-surface px-2 py-1 text-brand-700 hover:bg-brand-100">
                {copied ? "U kopjua ✓" : "Kopjo linkun"}
              </button>
              <a href={bookingUrl} target="_blank" rel="noreferrer" className="rounded-md px-2 py-1 text-brand-700 hover:bg-brand-100">
                Hape
              </a>
            </div>
          </div>
          <div className="border-t border-line pt-3">
            <p className="truncate text-sm font-medium">{session.user.fullName}</p>
            <p className="truncate text-xs text-ink-faint">
              {session.user.role === "admin" ? "Administrator" : "Stomatolog"} · {session.clinic.name}
            </p>
            <button type="button" onClick={() => void logout()} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
              Dil
            </button>
          </div>
        </div>
      </aside>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8 lg:py-8">
        {/* If a page's code is still on its way, the navigation stays in place meanwhile. */}
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
        <p className="mt-10 border-t border-line pt-4 text-sm text-ink-soft lg:hidden">
          {session.user.fullName} · {session.user.role === "admin" ? "Administrator" : "Stomatolog"} · {session.clinic.name}
        </p>
      </main>
    </div>
  );
}
