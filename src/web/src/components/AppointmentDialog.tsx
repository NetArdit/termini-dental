import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../auth";
import { ApiError, api, type Appointment, type Report, type ReportVersion } from "../lib/api";
import { dateOf, fmtDateTime, fmtTime, today, fmtMoney } from "../lib/format";
import { Badge, Button, Field, Input, Loading, Modal, Notice, StatusBadge, Textarea, useToast } from "../ui";
import { VisitImages } from "./VisitImages";

// One appointment, opened from the calendar, the reports page or a patient's history: its details, what can
// be done with it now, and the visit report.

interface Detail {
  appointment: Appointment;
  report: Report | null;
  versions: ReportVersion[];
}

interface CancelResult {
  late: boolean;
  emailStatus: "accepted" | "stored" | "failed" | "no_email";
  patientPhone: string | null;
  patientName: string;
}

export function AppointmentDialog({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const { clinic } = useSession();
  const zone = clinic.timezone;
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workDone, setWorkDone] = useState("");
  const [nextVisit, setNextVisit] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [needsLateConfirm, setNeedsLateConfirm] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelResult, setCancelResult] = useState<CancelResult | null>(null);

  // The appointment this dialog is open on right now. An answer can arrive after the user has closed the
  // dialog or opened another appointment; shown then, it would put one patient's details and buttons under
  // another's name. Every answer is checked against this before it touches the screen.
  const openId = useRef<number | null>(id);

  async function load(appointmentId: number) {
    try {
      const d = await api.get<Detail>(`/api/appointments/${appointmentId}`);
      if (openId.current !== appointmentId) return;
      setDetail(d);
      setWorkDone(d.report?.workDone ?? "");
      setNextVisit(d.report?.nextVisitDays ? String(d.report.nextVisitDays) : "");
    } catch (err) {
      if (openId.current !== appointmentId) return;
      setLoadError(err instanceof Error ? err.message : "Gabim.");
    }
  }

  useEffect(() => {
    openId.current = id;
    setDetail(null);
    setLoadError(null);
    setFormError(null);
    setCancelOpen(false);
    setReason("");
    setNeedsLateConfirm(null);
    setCancelResult(null);
    setSaving(false);
    setCancelBusy(false);
    if (id !== null) void load(id);
  }, [id]);

  /** True while the dialog is still open on the appointment an action was started for. */
  const stillOn = (appointmentId: number) => openId.current === appointmentId;

  const a = detail?.appointment;
  const started = a ? new Date(a.startsAt) <= new Date() : false;
  // A report describes work that was done: from the day of the visit on, never for a cancelled appointment.
  const canReport = a ? a.status !== "cancelled" && dateOf(a.startsAt, zone) <= today(zone) : false;

  async function saveReport() {
    if (!a) return;
    setSaving(true);
    setFormError(null);
    const target = a.id;
    try {
      await api.put(`/api/appointments/${target}/report`, { workDone, nextVisitDays: nextVisit ? Number(nextVisit) : null });
      toast(`Raporti u ruajt: ${a.patientName}`);
      await load(target);
      onChanged();
    } catch (err) {
      const message = err instanceof ApiError ? (err.fields.workDone ?? err.fields.nextVisitDays ?? err.message) : "Ruajtja dështoi.";
      // Meanwhile on another appointment: the failure still has to be seen, but not inside that one's form.
      if (stillOn(target)) setFormError(message);
      else toast(`${a.patientName}: ${message}`, "danger");
    } finally {
      if (stillOn(target)) setSaving(false);
    }
  }

  async function setStatus(status: "completed" | "no_show" | "booked") {
    if (!a) return;
    const target = a.id;
    try {
      await api.post(`/api/appointments/${target}/status`, { status });
      // Meanwhile on another appointment: say whose mark it was, since this dialog no longer shows it.
      if (!stillOn(target)) toast(`${a.patientName}: ${status === "completed" ? "u shënua se erdhi" : status === "no_show" ? "u shënua se nuk erdhi" : "shënimi u hoq"}`);
      await load(target);
      onChanged();
    } catch (err) {
      toast(`${a.patientName}: ${err instanceof Error ? err.message : "Gabim."}`, "danger");
    }
  }

  async function cancel(confirmLate: boolean) {
    if (!a) return;
    setCancelBusy(true);
    setFormError(null);
    const target = a.id;
    try {
      const res = await api.post<CancelResult>(`/api/appointments/${target}/cancel`, { reason, confirmLate });
      onChanged();
      if (!stillOn(target)) {
        // The dialog has moved on. The outcome (above all "the email did not go out, phone them") must not
        // be lost, and must not appear under another patient's name.
        const told = res.emailStatus === "accepted" ? "emaili iu dorëzua serverit të emailit" : `pacienti NUK u njoftua me email${res.patientPhone ? `, telefononi ${res.patientPhone}` : ""}`;
        toast(`Termini i ${res.patientName} u anulua: ${told}.`, res.emailStatus === "accepted" ? "ok" : "danger");
        return;
      }
      setCancelResult(res);
      setCancelOpen(false);
      await load(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Anulimi dështoi.";
      if (!stillOn(target)) toast(`${a.patientName}: ${message}`, "danger");
      else if (err instanceof ApiError && err.code === "late_cancellation") setNeedsLateConfirm(err.message);
      else setFormError(message);
    } finally {
      if (stillOn(target)) setCancelBusy(false);
    }
  }

  return (
    <Modal open={id !== null} onClose={onClose} title={a ? a.patientName : "Termini"} wide>
      {loadError ? (
        <Notice tone="danger">{loadError}</Notice>
      ) : !detail || !a ? (
        <Loading />
      ) : (
        <div className="space-y-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={a.status} />
              <Badge>{a.source === "online" ? "Rezervuar online" : "Shtuar nga klinika"}</Badge>
              {a.cancelLate ? <Badge tone="warn">Anulim i vonë</Badge> : null}
            </div>
            {a.deposit ? (
              <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm">
                <span className="font-medium">Depozitë {fmtMoney(a.deposit.amountMinor, a.deposit.currency)}:</span> zbritet nga fatura në vizitë.{" "}
                <span className="text-ink-soft">Demonstrim: nuk është arkëtuar asnjë pagesë.</span>
              </p>
            ) : null}
            <p className="mt-3 text-lg font-medium first-letter:uppercase">
              {fmtDateTime(a.startsAt, zone)} – {fmtTime(a.endsAt, zone)}
            </p>
            <p className="text-ink-soft">
              {a.serviceName} · {a.dentistName}
            </p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {a.patientPhone ? (
                <a href={`tel:${a.patientPhone}`} className="tap font-medium text-brand-700 underline underline-offset-2">
                  {a.patientPhone}
                </a>
              ) : (
                <span className="text-ink-faint">Pa telefon</span>
              )}
              {a.patientEmail ? <span className="text-ink-soft">{a.patientEmail}</span> : <span className="text-ink-faint">Pa email</span>}
              <Link to={`/app/pacientet/${a.patientId}`} onClick={onClose} className="tap font-medium text-brand-700 underline underline-offset-2">
                Kartela e pacientit
              </Link>
            </p>
            {a.status === "cancelled" ? (
              <p className="mt-2 text-sm text-ink-soft">
                Anuluar nga {a.cancelledBy === "patient" ? "pacienti" : "klinika"}
                {a.cancelReason ? ` — ${a.cancelReason}` : ""}
              </p>
            ) : null}
          </div>

          {cancelResult ? (
            cancelResult.emailStatus === "accepted" ? (
              <Notice tone="ok" title="Termini u anulua">
                Emaili i anulimit iu dorëzua serverit të emailit. Kjo nuk vërteton që pacienti e ka lexuar: për një anulim në minutën e fundit, telefonojeni
                {cancelResult.patientPhone ? (
                  <>
                    {" "}
                    në{" "}
                    <a className="font-semibold underline" href={`tel:${cancelResult.patientPhone}`}>
                      {cancelResult.patientPhone}
                    </a>
                  </>
                ) : null}
                .
              </Notice>
            ) : (
              <Notice tone="danger" title="Termini u anulua, por pacienti NUK u njoftua me email">
                {cancelResult.emailStatus === "no_email"
                  ? "Pacienti nuk ka email."
                  : cancelResult.emailStatus === "stored"
                    ? "Serveri i emailit nuk është konfiguruar, prandaj mesazhi vetëm u ruajt te Emailat."
                    : "Emaili nuk u dërgua dot."}{" "}
                {cancelResult.patientPhone ? (
                  <>
                    Telefonojeni {cancelResult.patientName} në{" "}
                    <a className="font-semibold underline" href={`tel:${cancelResult.patientPhone}`}>
                      {cancelResult.patientPhone}
                    </a>
                    .
                  </>
                ) : (
                  "Pacienti nuk ka as numër telefoni të regjistruar."
                )}
              </Notice>
            )
          ) : a.lastEmailStatus === "failed" ? (
            <Notice tone="warn">Emaili i fundit për këtë termin nuk u dërgua. Shihni te Emailat.</Notice>
          ) : null}

          {a.status !== "cancelled" ? (
            <div className="flex flex-wrap gap-2">
              {started ? (
                <>
                  {/* "Erdhi" is what saving the report says. The button only puts the mark back on a visit whose report exists. */}
                  {detail?.report ? (
                    <Button variant={a.status === "completed" ? "primary" : "secondary"} size="sm" onClick={() => setStatus("completed")}>
                      Erdhi
                    </Button>
                  ) : null}
                  <Button variant={a.status === "no_show" ? "primary" : "secondary"} size="sm" onClick={() => setStatus("no_show")}>
                    Nuk erdhi
                  </Button>
                </>
              ) : a.status === "booked" && !cancelOpen ? (
                <Button variant="secondary" size="sm" onClick={() => setCancelOpen(true)}>
                  Anulo terminin
                </Button>
              ) : null}
            </div>
          ) : null}

          {cancelOpen ? (
            <div className="space-y-3 rounded-xl border border-danger-600/30 bg-danger-bg/50 p-4">
              <p className="font-medium text-danger-fg">Anulimi i terminit</p>
              <p className="text-sm text-ink-soft">Pacientit i dërgohet një email. Pas anulimit ju tregohet nëse emaili u pranua nga serveri apo duhet ta telefononi.</p>
              <Field label={needsLateConfirm ? "Arsyeja (e detyrueshme)" : "Arsyeja (i shfaqet pacientit)"}>
                {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="p.sh. Stomatologu mungon atë ditë" maxLength={300} />}
              </Field>
              {needsLateConfirm ? <Notice tone="warn">{needsLateConfirm}</Notice> : null}
              {formError ? <Notice tone="danger">{formError}</Notice> : null}
              <div className="flex flex-wrap gap-2">
                {needsLateConfirm ? (
                  <Button variant="danger" busy={cancelBusy} disabled={!reason.trim()} onClick={() => cancel(true)}>
                    Anuloje gjithsesi
                  </Button>
                ) : (
                  <Button variant="danger" busy={cancelBusy} onClick={() => cancel(false)}>
                    Anulo dhe njofto pacientin
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setCancelOpen(false)}>
                  Mos e anulo
                </Button>
              </div>
            </div>
          ) : null}

          <div className="border-t border-line pt-5">
            <h3 className="font-display text-lg font-semibold tracking-tight">Raporti i vizitës</h3>
            {!canReport ? (
              <p className="mt-1 text-sm text-ink-soft">{a.status === "cancelled" ? "Për një termin të anuluar nuk shkruhet raport." : "Raporti shkruhet në ditën e terminit ose më pas."}</p>
            ) : (
              <div className="mt-3 space-y-3">
                <Field label="Çfarë u punua">
                  {(p) => <Textarea {...p} rows={5} value={workDone} onChange={(e) => setWorkDone(e.target.value)} placeholder="p.sh. Mbushje me ilaç në dhëmbin 36." />}
                </Field>
                <div className="max-w-56">
                  <Field label="Termini i radhës pas (ditë)" hint="Bosh nëse nuk nevojitet.">
                    {(p) => <Input {...p} type="number" min={1} max={730} inputMode="numeric" value={nextVisit} onChange={(e) => setNextVisit(e.target.value)} placeholder="p.sh. 14" />}
                  </Field>
                </div>
                {formError && !cancelOpen ? <Notice tone="danger">{formError}</Notice> : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button busy={saving} disabled={!workDone.trim()} onClick={saveReport}>
                    {detail.report ? "Ruaj ndryshimet" : "Ruaj raportin"}
                  </Button>
                  {detail.report ? (
                    <span className="text-sm text-ink-faint">
                      Versioni {detail.report.version} · {detail.report.authorName} · {fmtDateTime(detail.report.updatedAt, zone)}
                    </span>
                  ) : null}
                </div>
                {detail.versions.length > 1 ? (
                  <details className="rounded-xl border border-line bg-paper/60 p-3 text-sm">
                    <summary className="font-medium">Versionet e mëparshme ({detail.versions.length - 1})</summary>
                    <ul className="mt-3 space-y-3">
                      {detail.versions.slice(1).map((v) => (
                        <li key={v.version} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                          <p className="text-xs text-ink-faint">
                            Versioni {v.version} · {v.authorName} · {fmtDateTime(v.savedAt, zone)}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">{v.workDone}</p>
                          {v.nextVisitDays ? <p className="mt-1 text-ink-soft">Termini i radhës pas {v.nextVisitDays} ditësh</p> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            )}
          </div>

          {a.status !== "cancelled" ? <VisitImages appointmentId={a.id} zone={zone} canAdd={canReport} /> : null}
        </div>
      )}
    </Modal>
  );
}
