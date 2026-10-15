import { useState } from "react";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useSession } from "../auth";
import { Stars } from "../components/Stars";
import { Badge, Button, Card, Empty, LoadError, Loading, PageHeader, useLoad, useToast } from "../ui";

// The administrator's page for patients' reviews: read each one, then decide whether it is shown on the
// public pages. A review is never edited here: only shown or not shown.

interface Review {
  id: number;
  rating: number;
  comment: string | null;
  status: "pending" | "published" | "hidden";
  createdAt: string;
  dentistName: string;
  patientName: string;
  visitAt: string;
}

const STATUS: Record<Review["status"], { label: string; tone: "warn" | "ok" | "neutral" }> = {
  pending: { label: "Pret miratimin", tone: "warn" },
  published: { label: "E publikuar", tone: "ok" },
  hidden: { label: "E fshehur", tone: "neutral" },
};

export function Reviews() {
  const { clinic } = useSession();
  const toast = useToast();
  const list = useLoad(() => api.get<{ reviews: Review[] }>("/api/reviews"), []);
  const [busy, setBusy] = useState<number | null>(null);

  async function set(review: Review, status: "published" | "hidden") {
    setBusy(review.id);
    try {
      await api.patch(`/api/reviews/${review.id}`, { status });
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Ndryshimi dështoi.", "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Vlerësimet" subtitle="Çfarë kanë shkruar pacientët pas vizitës. Në faqen publike shfaqen vetëm ato që i miratoni ju, pa emrin e pacientit." />
      {list.loading && !list.data ? (
        <Loading />
      ) : list.error || !list.data ? (
        <LoadError message={list.error ?? "Vlerësimet nuk u ngarkuan."} onRetry={list.reload} />
      ) : list.data.reviews.length === 0 ? (
        <Empty title="Ende asnjë vlerësim">Pas një vizite të kryer, pacienti mund ta vlerësojë stomatologun nga linku i terminit të vet.</Empty>
      ) : (
        <ul className="space-y-3">
          {list.data.reviews.map((v) => (
            <li key={v.id}>
              <Card className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Stars value={v.rating} />
                  <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
                </div>
                {v.comment ? <p className="mt-3 whitespace-pre-wrap">{v.comment}</p> : <p className="mt-3 text-sm text-ink-faint">Pa koment.</p>}
                <p className="mt-3 text-sm text-ink-soft">
                  {v.patientName} për {v.dentistName} · vizita {fmtDateTime(v.visitAt, clinic.timezone)}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {v.status !== "published" ? (
                    <Button size="sm" busy={busy === v.id} onClick={() => void set(v, "published")}>
                      Publiko
                    </Button>
                  ) : null}
                  {v.status !== "hidden" ? (
                    <Button size="sm" variant="secondary" busy={busy === v.id} onClick={() => void set(v, "hidden")}>
                      {v.status === "published" ? "Hiqe nga faqja" : "Mos e publiko"}
                    </Button>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
