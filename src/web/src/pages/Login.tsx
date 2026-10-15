import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { ApiError, api } from "../lib/api";
import { Button, Card, Field, Input, Notice } from "../ui";
import { Mark } from "./Home";

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 text-xl font-bold tracking-tight whitespace-nowrap ${light ? "text-white" : "text-ink"}`}>
      <Mark className="size-8" />
      Rrënja Dental
    </span>
  );
}

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="tap mb-8 inline-block">
          <Logo />
        </Link>
        <Card className="p-6 sm:p-8">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 mb-6 text-ink-soft">{subtitle}</p>
          {children}
        </Card>
        {footer ? <p className="mt-6 text-center text-sm text-ink-soft">{footer}</p> : null}
      </div>
    </main>
  );
}

export function Login() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/app" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { email, password });
      await refresh();
      navigate("/app");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kyçja dështoi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Kyçu"
      subtitle="Hyrja për stafin e klinikës."
      footer={
        <Link to="/harrova-fjalekalimin" className="font-medium text-brand-700 underline underline-offset-2">
          Keni harruar fjalëkalimin?
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Fjalëkalimi">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" size="lg" className="w-full" busy={busy}>
          Kyçu
        </Button>
      </form>
    </AuthShell>
  );
}

/** Asks for a link to set a new password. The answer is the same for every address, known or not. */
export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/forgot", { email });
      setAsked(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Kërkesa dështoi. Provoni përsëri.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Fjalëkalim i ri"
      subtitle="Shkruani emailin me të cilin kyçeni. Ju dërgojmë një link për të vendosur një fjalëkalim të ri."
      footer={
        <Link to="/kycu" className="font-medium text-brand-700 underline underline-offset-2">
          Kthehu te kyçja
        </Link>
      }
    >
      {asked ? (
        <Notice tone="info">
          Nëse ky email i përket një llogarie të klinikës, linku është nisur. Vlen 30 minuta dhe punon vetëm një herë. Nuk ju erdhi brenda pak minutash? Shikoni te mesazhet e padëshiruara, provoni përsëri, ose kërkojini administratorit t'jua ndryshojë fjalëkalimin.
        </Notice>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" size="lg" className="w-full" busy={busy}>
            Dërgo linkun
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

/** The page the link opens. The secret is after "#", which the browser never sends to a server by itself. */
export function NewPassword() {
  const navigate = useNavigate();
  const [token] = useState(() => window.location.hash.slice(1));
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError("Dy fjalëkalimet nuk përputhen.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/reset", { token, password });
      // The secret has done its work: it does not stay in the address bar or in the history.
      window.history.replaceState(null, "", window.location.pathname);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ndryshimi dështoi. Provoni përsëri.");
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <Link to="/harrova-fjalekalimin" className="font-medium text-brand-700 underline underline-offset-2">
      Kërko një link të ri
    </Link>
  );

  if (!token) {
    return (
      <AuthShell title="Fjalëkalim i ri" subtitle="Ky link nuk është i plotë." footer={footer}>
        <Notice tone="warn">Hapeni linkun ashtu siç është në email, ose kërkoni një të ri.</Notice>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Fjalëkalim i ri" subtitle="Zgjidhni fjalëkalimin me të cilin do të kyçeni tani e tutje." footer={done ? undefined : footer}>
      {done ? (
        <div className="space-y-4">
          <Notice tone="ok">Fjalëkalimi u ndryshua. Për siguri, u mbyllën të gjitha kyçjet e hapura në pajisje të tjera.</Notice>
          <Button size="lg" className="w-full" onClick={() => navigate("/kycu")}>
            Kyçu
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field label="Fjalëkalimi i ri" hint="Të paktën 8 shkronja.">
            {(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label="Përsëriteni">{(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={8} value={again} onChange={(e) => setAgain(e.target.value)} />}</Field>
          <Button type="submit" size="lg" className="w-full" busy={busy}>
            Ruaj fjalëkalimin
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
