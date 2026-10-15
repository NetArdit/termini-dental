import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import { fmtMoney } from "../lib/format";
import { StarPicker, Stars } from "../components/Stars";
import { Button, Card, Loading, Notice, Textarea, useLoad } from "../ui";
import { Logo } from "./Login";

// What the private link in the confirmation email opens: the appointment, and a way to cancel it.

interface View {
  review: { rating: number; comment: string | null } | null;
  canReview: boolean;
  appointment: { clinicName: string; clinicPhone: string | null; dentistName: string; serviceName: string; patientName: string | null; when: string; status: string; deposit: { mode: string; amountMinor: number; currency: string } | null };
}

export function PatientAppointment() {
  // The link is /termin#<token>. A browser keeps what follows "#" to itself and the page hands it to the
  // server in a header, so the token is in no address that a server or a proxy on the way writes down.
  const token = useLocation().hash.slice(1);
  const secret = { "x-appointment-token": token };
  const view = useLoad(() => api.get<View>("/api/public/appointment", secret), [token]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  async function sendReview() {
    if (!rating) {
      setReviewError("Zgjidhni sa yje i jepni.");
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    try {
      await api.post("/api/public/appointment/review", { rating, comment: comment.trim() || null }, secret);
      view.reload();
    } catch (err) {
      setReviewError(err instanceof ApiError ? err.message : "Vlerësimi nuk u dërgua. Provoni përsëri.");
    } finally {
      setReviewBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/public/appointment/cancel", {}, secret);
      setCancelled(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Anulimi dështoi.");
    } finally {
      setBusy(false);
    }
  }

  const a = view.data?.appointment;

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="tap mb-8 inline-block">
          <Logo />
        </Link>
        <Card className="p-6 sm:p-8">
          {view.loading ? (
            <Loading />
          ) : cancelled ? (
            <>
              <h1 className="font-display text-2xl font-semibold tracking-tight">Termini u anulua</h1>
              <p className="mt-2 text-ink-soft">Faleminderit që na njoftuat. Orari u lirua për pacientë të tjerë.</p>
            </>
          ) : !a ? (
            <>
              <h1 className="font-display text-2xl font-semibold tracking-tight">Linku nuk është më i vlefshëm</h1>
              <p className="mt-2 text-ink-soft">Termini është anuluar ose koha e tij ka kaluar. Për çdo pyetje kontaktoni klinikën.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-soft">Termini juaj</p>
              <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight first-letter:uppercase">{a.when}</h1>
              <dl className="mt-5 space-y-2 text-[15px]">
                {[
                  ["Klinika", a.clinicName],
                  ["Stomatologu", a.dentistName],
                  ["Shërbimi", a.serviceName],
                  ...(a.patientName ? [["Pacienti", a.patientName]] : []),
                  ...(a.deposit ? [["Depozita", `${fmtMoney(a.deposit.amountMinor, a.deposit.currency)}, zbritet nga fatura (demonstrim: nuk u mor pagesë)`]] : []),
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 border-b border-line pb-2">
                    <dt className="text-ink-soft">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              {a.clinicPhone ? (
                <p className="mt-4 text-sm text-ink-soft">
                  Pyetje? Telefononi në{" "}
                  <a href={`tel:${a.clinicPhone}`} className="font-medium text-brand-700 underline">
                    {a.clinicPhone}
                  </a>
                  .
                </p>
              ) : null}
              {error ? (
                <div className="mt-4">
                  <Notice tone="danger">{error}</Notice>
                </div>
              ) : null}
              {a.status === "completed" ? (
                <div className="mt-6 border-t border-line pt-5">
                  <h2 className="text-lg font-semibold tracking-tight">Si ishte vizita te {a.dentistName}?</h2>
                  {view.data?.review ? (
                    <div className="mt-3">
                      <Stars value={view.data.review.rating} />
                      {view.data.review.comment ? <p className="mt-2 whitespace-pre-wrap text-ink-soft">{view.data.review.comment}</p> : null}
                      <p className="mt-3 text-sm text-ink-soft">Faleminderit për vlerësimin. Shfaqet në faqen e klinikës pasi ta shqyrtojë klinika, pa emrin tuaj.</p>
                    </div>
                  ) : (
                    <div className="mt-3 space-y-4">
                      <StarPicker name="rating" value={rating} onChange={setRating} />
                      <div>
                        <label htmlFor="review-comment" className="mb-1.5 block text-sm font-medium text-ink">
                          Koment <span className="font-normal text-ink-soft">(nëse doni)</span>
                        </label>
                        <Textarea id="review-comment" rows={3} maxLength={600} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Çfarë ju pëlqeu? Çfarë mund të bëjmë më mirë?" />
                      </div>
                      {reviewError ? <Notice tone="danger">{reviewError}</Notice> : null}
                      <Button busy={reviewBusy} onClick={() => void sendReview()}>
                        Dërgo vlerësimin
                      </Button>
                      <p className="text-xs text-ink-faint">Vlerësimi shfaqet pa emrin tuaj.</p>
                    </div>
                  )}
                </div>
              ) : null}
              <div className={a.status === "booked" ? "mt-6" : "hidden"}>
                {confirming ? (
                  <div className="rounded-xl bg-danger-bg p-4">
                    <p className="font-medium text-danger-fg">Ta anuloni këtë termin?</p>
                    <p className="mt-1 text-sm text-danger-fg">Ky veprim nuk kthehet. Për termin të ri duhet të rezervoni përsëri.</p>
                    <div className="mt-3 flex gap-2">
                      <Button variant="danger" busy={busy} onClick={cancel}>
                        Po, anuloje
                      </Button>
                      <Button variant="secondary" onClick={() => setConfirming(false)}>
                        Jo, mbaje
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="secondary" onClick={() => setConfirming(true)}>
                    Nuk mund të vij — anulo terminin
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
