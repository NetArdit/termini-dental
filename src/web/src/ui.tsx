import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { AppointmentStatus } from "./lib/api";

// The small set of building blocks every page uses, so buttons, fields and dialogs look and behave the
// same everywhere.

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

// ---- buttons ---------------------------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-900 disabled:bg-brand-200 disabled:text-white",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-brand-50 hover:border-brand-200 disabled:text-ink-faint disabled:bg-paper",
  ghost: "text-brand-700 hover:bg-brand-50 disabled:text-ink-faint",
  danger: "bg-danger-600 text-white hover:bg-danger-fg disabled:opacity-50",
};

export function Button({
  variant = "primary",
  size = "md",
  busy = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; busy?: boolean }) {
  const sizes = { sm: "h-8 px-3 text-sm", md: "h-10 px-4 text-sm", lg: "h-12 px-6 text-base" };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx("inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors", sizes[size], VARIANTS[variant], className)}
    >
      {busy ? <Spinner small /> : null}
      {children}
    </button>
  );
}

export function Spinner({ small = false }: { small?: boolean }) {
  return <span role="status" aria-label="Duke u ngarkuar" className={cx("inline-block animate-spin rounded-full border-2 border-current border-r-transparent", small ? "size-4" : "size-6 text-brand-500")} />;
}

export function Loading({ label = "Duke u ngarkuar…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-ink-soft">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

// ---- form fields -----------------------------------------------------------------------------------------

const fieldBase =
  "w-full rounded-lg border bg-surface px-3 text-[15px] text-ink placeholder:text-ink-faint transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-paper disabled:text-ink-faint";

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode }) {
  const id = useId();
  const describedBy = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {error ? (
        <p id={`${id}-e`} className="mt-1.5 text-sm text-danger-fg">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-h`} className="mt-1.5 text-sm text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(fieldBase, "h-10", props["aria-invalid"] ? "border-danger-600" : "border-line-strong", props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(fieldBase, "h-10", props["aria-invalid"] ? "border-danger-600" : "border-line-strong", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={4} {...props} className={cx(fieldBase, "py-2 leading-relaxed", props["aria-invalid"] ? "border-danger-600" : "border-line-strong", props.className)} />;
}

// ---- surfaces --------------------------------------------------------------------------------------------

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-2xl border border-line bg-surface shadow-card", className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-ink-soft">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{children}</div> : null}
    </div>
  );
}

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";
const TONES: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok-fg",
  warn: "bg-warn-bg text-warn-fg",
  danger: "bg-danger-bg text-danger-fg",
  info: "bg-info-bg text-info-fg",
  neutral: "bg-paper text-ink-soft border border-line",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone])}>{children}</span>;
}

export function Notice({ tone = "info", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "note"} className={cx("rounded-xl px-4 py-3 text-sm leading-relaxed", TONES[tone])}>
      {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}

const STATUS: Record<AppointmentStatus, { label: string; tone: Tone }> = {
  booked: { label: "I caktuar", tone: "info" },
  completed: { label: "I kryer", tone: "ok" },
  no_show: { label: "Nuk erdhi", tone: "warn" },
  cancelled: { label: "I anuluar", tone: "danger" },
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

// ---- dialog ----------------------------------------------------------------------------------------------

/** A modal built on the browser's own <dialog>: focus is trapped and Escape closes it without extra code. */
export function Modal({ open, onClose, title, children, footer, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={open ? titleId : undefined}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx("m-auto w-[calc(100%-2rem)] rounded-2xl bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/50", wide ? "max-w-2xl" : "max-w-lg")}
    >
      {open ? (
        <div className="flex max-h-[85dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight">
              {title}
            </h2>
            <button type="button" onClick={onClose} aria-label="Mbyll" className="-mr-2 grid size-8 place-items-center rounded-lg text-ink-soft hover:bg-paper">
              <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-paper/60 px-6 py-4">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

// ---- toasts ----------------------------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "danger";
}
const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = next.current++;
    setToasts((all) => [...all, { id, text, tone }]);
    // Errors stay longer: they usually need to be read twice.
    window.setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === "danger" ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} className={cx("animate-rise pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm font-medium shadow-pop", t.tone === "ok" ? "bg-ink text-white" : "bg-danger-600 text-white")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---- data loading ----------------------------------------------------------------------------------------

/** Loads something, and reloads when `deps` change or `reload()` is called. Stale answers are dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => current && setState({ data, error: null, loading: false }),
      (err: unknown) => current && setState({ data: null, error: err instanceof Error ? err.message : "Gabim i panjohur.", loading: false }),
    );
    return () => {
      current = false;
    };
    // `load` is recreated on every render by design; the caller's `deps` decide when to run it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-6 py-10 text-center">
      <p className="font-medium text-ink">Nuk u ngarkua</p>
      <p className="mt-1 text-sm text-ink-soft">{message}</p>
      <Button variant="secondary" className="mt-4" onClick={onRetry}>
        Provo përsëri
      </Button>
    </div>
  );
}
