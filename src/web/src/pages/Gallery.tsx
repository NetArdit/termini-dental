import { useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { prepared } from "../components/VisitImages";
import { Badge, Button, Card, Empty, Field, Input, LoadError, Loading, Notice, PageHeader, Select, Textarea, useLoad, useToast } from "../ui";

// The administrator's page for "Punët tona", the gallery on the clinic's public pages.
//
// Every item says what allows it to be shown. An illustrative picture (a stock photograph, nobody's teeth)
// is labelled as such in public. A patient's picture needs the patient's written consent: the form asks when
// it was given and where the signed paper is kept, and without both it is not stored at all. If the patient
// takes the consent back, "Tërhiq pëlqimin" takes the item off the public pages at once and for good.

interface Item {
  id: number;
  title: string;
  description: string | null;
  basis: "illustrative" | "patient";
  status: "draft" | "published";
  consent: { givenOn: string; reference: string; recordedBy: string | null; revokedAt: string | null } | null;
  after: string;
  before: string | null;
}
type Picture = { contentType: "image/jpeg"; data: string };

const fmtDay = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

function PictureInput({ label, value, onChange }: { label: string; value: Picture | null; onChange: (p: Picture | null) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-ink">{label}</p>
      <div className="flex flex-wrap items-center gap-3">
        {value ? <img src={`data:${value.contentType};base64,${value.data}`} alt="" className="size-24 rounded-xl border border-line object-cover" /> : null}
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              onChange(await prepared(file));
            } catch {
              toast("Ky skedar nuk u hap si fotografi.", "danger");
            }
          }}
        />
        <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>
          {value ? "Ndërroje" : "Zgjidh fotografinë"}
        </Button>
        {value ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Hiqe
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Gallery() {
  const toast = useToast();
  const list = useLoad(() => api.get<{ items: Item[]; limit: number }>("/api/gallery"), []);
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ title: "", description: "", basis: "illustrative" as Item["basis"], consentGivenOn: "", consentReference: "" });
  const [after, setAfter] = useState<Picture | null>(null);
  const [before, setBefore] = useState<Picture | null>(null);
  const patient = form.basis === "patient";
  const ready = form.title.trim() && after && (!patient || (form.consentGivenOn && form.consentReference.trim()));

  async function act(id: number, run: () => Promise<unknown>, done: string) {
    setBusy(id);
    try {
      await run();
      toast(done);
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Ndryshimi dështoi.", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!ready || !after) return;
    setBusy("new");
    try {
      await api.post("/api/gallery", {
        title: form.title,
        description: form.description || null,
        after,
        before,
        basis: form.basis,
        consentGivenOn: patient ? form.consentGivenOn : null,
        consentReference: patient ? form.consentReference : null,
      });
      setForm({ title: "", description: "", basis: "illustrative", consentGivenOn: "", consentReference: "" });
      setAfter(null);
      setBefore(null);
      toast("U shtua si draft. Shfaqet në faqen publike pasi ta publikoni.");
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Shtimi dështoi.", "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Punët tona" subtitle="Galeria në faqen publike të klinikës. Fotografia e një pacienti shfaqet vetëm me pëlqimin e tij me shkrim." />

      <Card className="mb-6 p-5">
        <h2 className="font-display text-xl font-semibold tracking-tight">Punë e re</h2>
        <form onSubmit={add} className="mt-4 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Titulli">{(p) => <Input {...p} required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="p.sh. Zbardhim dhëmbësh" />}</Field>
            <Field label="Çfarë tregon fotografia">
              {(p) => (
                <Select {...p} value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as Item["basis"] })}>
                  <option value="illustrative">Foto ilustruese (jo pacient i klinikës)</option>
                  <option value="patient">Trajtimin e një pacienti tonë</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Përshkrimi (sipas dëshirës)">{(p) => <Textarea {...p} rows={2} maxLength={600} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <PictureInput label={patient ? "Pas trajtimit" : "Fotografia"} value={after} onChange={setAfter} />
            <PictureInput label="Para trajtimit (sipas dëshirës)" value={before} onChange={setBefore} />
          </div>
          {patient ? (
            <Notice tone="warn" title="Pëlqimi i pacientit">
              <p className="text-sm">Fotografia e dhëmbëve të një pacienti është e dhënë shëndetësore. Ruhet këtu vetëm nëse pacienti ka nënshkruar pëlqimin për shfaqje publike. Emri i tij nuk shkruhet dhe nuk shfaqet askund.</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Data kur u dha pëlqimi">{(p) => <Input {...p} type="date" required value={form.consentGivenOn} onChange={(e) => setForm({ ...form, consentGivenOn: e.target.value })} />}</Field>
                <Field label="Ku ruhet formulari i nënshkruar">
                  {(p) => <Input {...p} required maxLength={200} value={form.consentReference} onChange={(e) => setForm({ ...form, consentReference: e.target.value })} placeholder="p.sh. Dosja e pëlqimeve, nr. 14" />}
                </Field>
              </div>
            </Notice>
          ) : (
            <p className="text-sm text-ink-soft">Në faqen publike kjo fotografi mban shënimin “Foto ilustruese”, që të mos kuptohet si rezultat i klinikës.</p>
          )}
          <div>
            <Button type="submit" busy={busy === "new"} disabled={!ready}>
              Shto si draft
            </Button>
          </div>
        </form>
      </Card>

      {list.loading && !list.data ? (
        <Loading />
      ) : list.error || !list.data ? (
        <LoadError message={list.error ?? "Galeria nuk u ngarkua."} onRetry={list.reload} />
      ) : list.data.items.length === 0 ? (
        <Empty title="Galeria është bosh">Shtoni punën e parë më lart. Pa asnjë punë të publikuar, faqja publike nuk e shfaq fare këtë pjesë.</Empty>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {list.data.items.map((g) => {
            const revoked = !!g.consent?.revokedAt;
            return (
              <li key={g.id}>
                <Card className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h3 className="font-display text-lg font-semibold tracking-tight">{g.title}</h3>
                    <Badge tone={revoked ? "danger" : g.status === "published" ? "ok" : "neutral"}>{revoked ? "Pëlqimi u tërhoq" : g.status === "published" ? "E publikuar" : "Draft"}</Badge>
                  </div>
                  {g.description ? <p className="mt-2 text-sm whitespace-pre-wrap text-ink-soft">{g.description}</p> : null}
                  <div className="mt-3 flex gap-3">
                    {g.before ? (
                      <figure className="min-w-0 flex-1">
                        <img src={g.before} alt={`${g.title}, para`} className="aspect-[4/3] w-full rounded-xl border border-line object-cover" />
                        <figcaption className="mt-1 text-xs text-ink-faint">Para</figcaption>
                      </figure>
                    ) : null}
                    <figure className="min-w-0 flex-1">
                      <img src={g.after} alt={g.before ? `${g.title}, pas` : g.title} className="aspect-[4/3] w-full rounded-xl border border-line object-cover" />
                      {g.before ? <figcaption className="mt-1 text-xs text-ink-faint">Pas</figcaption> : null}
                    </figure>
                  </div>
                  <p className="mt-3 text-sm text-ink-soft">
                    {g.consent
                      ? `Pëlqimi i dhënë më ${fmtDay(g.consent.givenOn)} · ${g.consent.reference}${g.consent.recordedBy ? ` · shënoi ${g.consent.recordedBy}` : ""}${g.consent.revokedAt ? ` · u tërhoq më ${fmtDay(g.consent.revokedAt)}` : ""}`
                      : "Foto ilustruese: nuk tregon pacient të klinikës."}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {!revoked && g.status !== "published" ? (
                      <Button size="sm" busy={busy === g.id} onClick={() => void act(g.id, () => api.patch(`/api/gallery/${g.id}`, { status: "published" }), "U publikua.")}>
                        Publiko
                      </Button>
                    ) : null}
                    {g.status === "published" ? (
                      <Button size="sm" variant="secondary" busy={busy === g.id} onClick={() => void act(g.id, () => api.patch(`/api/gallery/${g.id}`, { status: "draft" }), "U hoq nga faqja publike.")}>
                        Hiqe nga faqja
                      </Button>
                    ) : null}
                    {g.consent && !revoked ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        busy={busy === g.id}
                        onClick={() => {
                          if (window.confirm("Pacienti e tërhoqi pëlqimin? Fotografia hiqet menjëherë nga faqja publike dhe nuk mund të publikohet më.")) void act(g.id, () => api.post(`/api/gallery/${g.id}/revoke`), "Pëlqimi u shënua si i tërhequr.");
                        }}
                      >
                        Tërhiq pëlqimin
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === g.id}
                      onClick={() => {
                        if (window.confirm(`Të fshihet “${g.title}” bashkë me fotografitë?`)) void act(g.id, () => api.del(`/api/gallery/${g.id}`), "U fshi.");
                      }}
                    >
                      Fshije
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
