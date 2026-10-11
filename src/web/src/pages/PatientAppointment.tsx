import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import { Button, Card, Loading, Notice, useLoad } from "../ui";
import { Logo } from "./Login";

// What the private link in the confirmation email opens: the appointment, and a way to cancel it.

interface View {
  appointment: { clinicName: string; clinicPhone: string | null; dentistName: string; serviceName: string; patientName: string; when: string; status: string };
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
                  ["Pacienti", a.patientName],
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
              <div className="mt-6">
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
