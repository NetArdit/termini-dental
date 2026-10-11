import { useState } from "react";
import { useSession } from "../auth";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { Badge, Button, Card, Empty, LoadError, Loading, Notice, PageHeader, useLoad, useToast } from "../ui";

// Every email the system tried to send to patients, with what is known about it. "Accepted" is as far as
// the system can see: the mail server took the message. Whether it reached the patient's inbox it cannot
// know, so nothing here says "delivered".

interface Email {
  id: number;
  to: string;
  kind: "booking_confirmation" | "cancelled_by_clinic" | "cancelled_by_patient" | "reminder";
  subject: string;
  body: string;
  status: "accepted" | "stored" | "failed";
  error: string | null;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  canResend: boolean;
}

const KIND: Record<Email["kind"], string> = {
  booking_confirmation: "Konfirmim",
  cancelled_by_clinic: "Anulim nga klinika",
  cancelled_by_patient: "Anulim nga pacienti",
  reminder: "Kujtesë",
};

const STATUS: Record<Email["status"], { label: string; tone: "ok" | "warn" | "danger" }> = {
  accepted: { label: "Pranuar nga serveri", tone: "ok" },
  stored: { label: "Vetëm i ruajtur", tone: "warn" },
  failed: { label: "Dështoi", tone: "danger" },
};

export function Outbox() {
  const { clinic } = useSession();
  const toast = useToast();
  const emails = useLoad(() => api.get<{ canSend: boolean; emails: Email[] }>("/api/emails"), []);
  const [resending, setResending] = useState<number | null>(null);
  const list = emails.data?.emails ?? [];
  const canSend = emails.data?.canSend ?? true;
  const waiting = list.some((e) => e.status !== "accepted");

  async function resend(e: Email) {
    setResending(e.id);
    try {
      const res = await api.post<{ status: Email["status"] }>(`/api/emails/${e.id}/resend`);
      if (res.status === "accepted") toast(`Serveri i emailit e pranoi mesazhin për ${e.to}`);
      else toast(`Mesazhi për ${e.to} dështoi përsëri. Njoftojeni pacientin me telefon.`, "danger");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Dërgimi dështoi.", "danger");
    } finally {
      setResending(null);
      emails.reload();
    }
  }

  return (
    <>
      <PageHeader title="Emailat" subtitle="100 mesazhet e fundit për pacientët dhe çfarë dihet për secilin." />
      <div className="mb-4 space-y-3">
        {!canSend ? (
          <Notice tone="warn" title="Serveri i emailit nuk është konfiguruar">
            Asnjë mesazh nuk u dërgohet pacientëve: ata ruhen vetëm këtu. Njoftojini pacientët me telefon. Kur të vendoset serveri i emailit (SMTP), mesazhet për termine që janë ende përpara dërgohen vetë; të tjerat nuk dërgohen më.
          </Notice>
        ) : waiting ? (
          <Notice tone="warn" title="Disa mesazhe nuk kanë arritur te serveri i emailit">
            Sistemi i provon vetë gjithsej tri herë, bashkë me përpjekjen e parë, dhe pastaj ndalet. Mund t'i dërgoni edhe me dorë, me butonin "Dërgo përsëri". Për një anulim që nuk del, telefonojeni pacientin.
          </Notice>
        ) : null}
        {list.some((e) => e.status === "accepted") ? (
          <p className="text-sm text-ink-soft">
            "Pranuar nga serveri" do të thotë se serveri i emailit e mori mesazhin. Nuk është vërtetim që pacienti e ka marrë: mesazhi mund të kthehet ose të bjerë te të padëshiruarat.
          </p>
        ) : null}
      </div>
      {emails.loading && !emails.data ? (
        <Loading />
      ) : emails.error ? (
        <LoadError message={emails.error} onRetry={emails.reload} />
      ) : list.length === 0 ? (
        <Empty title="Ende asnjë email">Konfirmimet, kujtesat dhe njoftimet e anulimit shfaqen këtu.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((e) => (
              <li key={e.id}>
                <details className="group">
                  <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 hover:bg-brand-50/60 sm:px-5">
                    <span className="min-w-0">
                      <span className="block font-medium break-words sm:truncate">{e.subject}</span>
                      <span className="block text-sm break-words text-ink-soft sm:truncate">
                        {e.to} · {KIND[e.kind]} · {fmtDateTime(e.createdAt, clinic.timezone)}
                      </span>
                    </span>
                    <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                  </summary>
                  <div className="border-t border-line bg-paper/60 px-4 py-4 sm:px-5">
                    {e.error ? <p className="mb-2 text-sm font-medium text-danger-fg">Gabimi: {e.error}</p> : null}
                    <p className="mb-2 text-sm text-ink-soft">
                      {e.attempts === 0 ? "Ende pa u provuar" : `Provuar ${e.attempts} herë`}
                      {e.lastAttemptAt ? `, për herë të fundit ${fmtDateTime(e.lastAttemptAt, clinic.timezone)}` : ""}.
                    </p>
                    <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{e.body}</pre>
                    {e.status !== "accepted" ? (
                      <div className="mt-3">
                        {e.canResend && canSend ? (
                          <Button variant="secondary" size="sm" busy={resending === e.id} onClick={() => void resend(e)}>
                            Dërgo përsëri
                          </Button>
                        ) : (
                          <p className="text-sm text-ink-soft">{e.canResend ? "Nuk mund të dërgohet pa server emaili." : "Termini i këtij mesazhi ka kaluar ose nuk është më aktiv, prandaj nuk dërgohet më."}</p>
                        )}
                      </div>
                    ) : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
