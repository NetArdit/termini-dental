import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { ApiError, api } from "../lib/api";
import { Button, Card, Field, Input, Notice } from "../ui";

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-display text-xl font-semibold tracking-tight whitespace-nowrap ${light ? "text-white" : "text-ink"}`}>
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
        <rect width="32" height="32" rx="8" className={light ? "fill-white/15" : "fill-brand-700"} />
        <path d="M11 8c-2.800 0-4.500 2-4.500 4.800 0 4.200 1.600 11.200 3.800 11.200 1.700 0 1.400-5 5.700-5s4 5 5.700 5c2.200 0 3.800-7 3.800-11.200C25.500 10 23.800 8 21 8c-2 0-3 1-5 1s-3-1-5-1z" fill="#f4f1ea" />
      </svg>
      Termini Dental
    </span>
  );
}

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
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
        <p className="mt-6 text-center text-sm text-ink-soft">{footer}</p>
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
      subtitle="Hyni në llogarinë e klinikës suaj."
      footer={
        <>
          Klinika juaj nuk është ende këtu?{" "}
          <Link to="/regjistrohu" className="font-medium text-brand-700 underline underline-offset-2">
            Regjistrojeni
          </Link>
        </>
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

export function Signup() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ clinicName: "", fullName: "", email: "", password: "", isDentist: true });
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/app" replace />;

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api.post("/api/auth/signup", form);
      await refresh();
      navigate("/app");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError("Regjistrimi dështoi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Regjistro klinikën"
      subtitle="Krijoni faqen e termineve për klinikën tuaj. Zgjat një minutë."
      footer={
        <>
          Keni llogari?{" "}
          <Link to="/kycu" className="font-medium text-brand-700 underline underline-offset-2">
            Kyçuni
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label="Emri i klinikës" error={fields.clinicName}>
          {(p) => <Input {...p} required placeholder="p.sh. Klinika Dentare Dr. Arta" value={form.clinicName} onChange={set("clinicName")} />}
        </Field>
        <Field label="Emri dhe mbiemri juaj" error={fields.fullName}>
          {(p) => <Input {...p} required autoComplete="name" placeholder="p.sh. Dr. Arta Krasniqi" value={form.fullName} onChange={set("fullName")} />}
        </Field>
        <Field label="Email" error={fields.email}>
          {(p) => <Input {...p} type="email" required autoComplete="username" value={form.email} onChange={set("email")} />}
        </Field>
        <Field label="Fjalëkalimi" error={fields.password} hint="Të paktën 8 shkronja.">
          {(p) => <Input {...p} type="password" required autoComplete="new-password" value={form.password} onChange={set("password")} />}
        </Field>
        <label className="flex items-start gap-3 rounded-xl border border-line bg-paper/60 p-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-brand-700" checked={form.isDentist} onChange={(e) => setForm((f) => ({ ...f, isDentist: e.target.checked }))} />
          <span>
            <span className="font-medium">Unë jam edhe stomatolog</span>
            <span className="block text-ink-soft">Pacientët mund të caktojnë termine edhe te unë.</span>
          </span>
        </label>
        <Button type="submit" size="lg" className="w-full" busy={busy}>
          Krijo klinikën
        </Button>
      </form>
    </AuthShell>
  );
}
