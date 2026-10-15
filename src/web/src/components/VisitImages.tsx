import { useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { ApiError, api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { Button, Modal, Notice, Select, useLoad, useToast } from "../ui";

// The pictures of a visit: X-rays and photographs. The dentist adds them beside the report, and at a later
// visit of the same patient sees the earlier ones here and can put one of them next to a new one.
// A picture is made small in the browser before it is sent (long side at most 1600 pixels, JPEG, under 1 MB), so that a
// phone's twelve-megapixel photograph does not travel whole.

export interface VisitImage {
  id: number;
  appointmentId: number;
  kind: "xray" | "photo";
  caption: string | null;
  uploadedBy: string;
  createdAt: string;
  visitAt: string;
  url: string;
}

const KIND: Record<VisitImage["kind"], string> = { xray: "Rentgen", photo: "Fotografi" };
const LONG_SIDE = 1600;
// What the server takes at most, with a little room to spare. Base64 writes three bytes as four characters.
const MAX_BASE64 = Math.floor((1_000_000 * 4) / 3);

/** The picture, scaled down and written as JPEG; as base64 without the "data:" prefix. */
export async function prepared(file: File): Promise<{ contentType: "image/jpeg"; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no canvas");
  // An X-ray saved as a PNG with a clear background would turn black as JPEG: white goes under it first.
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // As good as fits: a detailed X-ray is written a little more coarsely rather than refused.
  let data = "";
  for (const quality of [0.86, 0.75, 0.62, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    data = url.slice(url.indexOf(",") + 1);
    if (data.length <= MAX_BASE64) break;
  }
  return { contentType: "image/jpeg", data };
}

export function VisitImages({ appointmentId, zone, canAdd }: { appointmentId: number; zone: string; canAdd: boolean }) {
  const toast = useToast();
  const list = useLoad(() => api.get<{ images: VisitImage[]; earlier: VisitImage[]; limit: number }>(`/api/appointments/${appointmentId}/images`), [appointmentId]);
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<VisitImage["kind"]>("xray");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<VisitImage | null>(null);
  const [beside, setBeside] = useState<VisitImage | null>(null);

  if (list.loading && !list.data) return null;
  if (!list.data) return list.error ? <Notice tone="danger">{list.error}</Notice> : null;
  const { images, earlier, limit } = list.data;
  const full = images.length >= limit;

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, limit - images.length)) {
        if (!file.type.startsWith("image/")) throw new ApiError("Zgjidhni një fotografi (JPEG, PNG ose WebP).", 400);
        await api.post(`/api/appointments/${appointmentId}/images`, { kind, caption: null, ...(await prepared(file)) });
      }
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Fotografia nuk u lexua dot. Provoni një tjetër.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(image: VisitImage) {
    try {
      await api.del(`/api/images/${image.id}`);
      setOpen(null);
      setBeside(null);
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Fotografia nuk u hoq.", "danger");
    }
  }

  const thumb = (image: VisitImage) => (
    <li key={image.id}>
      <button
        type="button"
        onClick={() => {
          setOpen(image);
          setBeside(null);
        }}
        className="group block w-full overflow-hidden rounded-xl border border-line bg-paper text-left transition-shadow hover:shadow-card"
        aria-label={`${KIND[image.kind]}, ${fmtDateTime(image.visitAt, zone)}. Hape.`}
      >
        <img src={image.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
        <span className="block truncate px-2 py-1.5 text-xs text-ink-soft">{KIND[image.kind]}</span>
      </button>
    </li>
  );

  return (
    <div className="border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-lg font-semibold tracking-tight">Rentgenet dhe fotografitë</h3>
        {canAdd ? (
          <div className="flex items-center gap-2">
            <Select aria-label="Lloji i fotografisë" value={kind} onChange={(e) => setKind(e.target.value as VisitImage["kind"])} className="h-9 text-sm">
              <option value="xray">Rentgen</option>
              <option value="photo">Fotografi</option>
            </Select>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void add(e.target.files)} />
            <Button variant="secondary" size="sm" busy={busy} disabled={full} onClick={() => input.current?.click()}>
              Shto
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}

      {images.length ? (
        <ul className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4">{images.map(thumb)}</ul>
      ) : (
        <p className="mt-1 text-sm text-ink-soft">{canAdd ? "Kësaj vizite nuk i është shtuar ende asnjë fotografi." : "Fotografitë shtohen në ditën e terminit ose më pas."}</p>
      )}
      {full ? <p className="mt-2 text-xs text-ink-faint">Një vizitë mban më së shumti {limit} fotografi.</p> : null}

      {earlier.length ? (
        <div className="mt-5">
          <h4 className="text-sm font-semibold text-ink-soft">Nga vizitat e mëparshme</h4>
          <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">{earlier.map(thumb)}</ul>
        </div>
      ) : null}

      <Modal open={open !== null} onClose={() => setOpen(null)} title={open ? `${KIND[open.kind]} · ${fmtDateTime(open.visitAt, zone)}` : "Fotografia"} wide>
        {open ? (
          <div className="space-y-4">
            <div className={`grid gap-3 ${beside ? "sm:grid-cols-2" : ""}`}>
              <figure>
                <ZoomImage key={open.id} src={open.url} alt={`${KIND[open.kind]} e vizitës së datës ${fmtDateTime(open.visitAt, zone)}`} />
                <figcaption className="mt-1 text-xs text-ink-faint">Shtuar nga {open.uploadedBy}</figcaption>
              </figure>
              {beside ? (
                <figure>
                  <ZoomImage key={beside.id} src={beside.url} alt={`${KIND[beside.kind]} e vizitës së datës ${fmtDateTime(beside.visitAt, zone)}`} />
                  <figcaption className="mt-1 text-xs text-ink-faint">
                    {KIND[beside.kind]} · {fmtDateTime(beside.visitAt, zone)}
                  </figcaption>
                </figure>
              ) : null}
            </div>
            {/* Side by side with another picture of the same patient: the point of keeping the old ones. */}
            {[...images, ...earlier].filter((i) => i.id !== open.id).length ? (
              <div>
                <p className="text-sm font-medium">Krahaso me</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {[...images, ...earlier]
                    .filter((i) => i.id !== open.id)
                    .map((i) => (
                      <li key={i.id}>
                        <button
                          type="button"
                          aria-pressed={beside?.id === i.id}
                          onClick={() => setBeside(beside?.id === i.id ? null : i)}
                          className={`block overflow-hidden rounded-lg border-2 ${beside?.id === i.id ? "border-brand-700" : "border-transparent"}`}
                          aria-label={`${KIND[i.kind]}, ${fmtDateTime(i.visitAt, zone)}`}
                        >
                          <img src={i.url} alt="" className="size-14 object-cover" />
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
            {canAdd && open.appointmentId === appointmentId ? (
              <Button variant="secondary" size="sm" onClick={() => void remove(open)}>
                Hiqe këtë fotografi
              </Button>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

const MAX_ZOOM = 6;

/**
 * A picture that can be looked at closely: enlarged with the buttons, the mouse wheel or a double click, and
 * moved by dragging once it is larger than its frame. An X-ray is read in its details, not at a glance.
 */
function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = useState(1);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const set = (next: number) => {
    const z = Math.min(MAX_ZOOM, Math.max(1, Math.round(next * 100) / 100));
    setZoom(z);
    // Back at its own size there is nothing to move around in.
    if (z === 1) setAt({ x: 0, y: 0 });
  };
  const onWheel = (e: WheelEvent) => set(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (zoom === 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: at.x, oy: at.y };
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return;
    setAt({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y });
  };
  const onUp = () => {
    drag.current = null;
  };

  return (
    <div>
      <div
        className={`relative h-[60dvh] touch-none overflow-hidden rounded-xl bg-ink select-none ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => set(zoom > 1 ? 1 : 2.5)}
      >
        <img src={src} alt={alt} draggable={false} className="h-full w-full object-contain" style={{ transform: `translate(${at.x}px, ${at.y}px) scale(${zoom})`, transition: drag.current ? "none" : "transform 120ms ease-out" }} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="secondary" size="sm" aria-label="Zvogëlo" disabled={zoom <= 1} onClick={() => set(zoom / 1.5)}>
          −
        </Button>
        <span className="w-14 text-center text-sm text-ink-soft tabular-nums" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <Button variant="secondary" size="sm" aria-label="Zmadho" disabled={zoom >= MAX_ZOOM} onClick={() => set(zoom * 1.5)}>
          +
        </Button>
        <Button variant="ghost" size="sm" disabled={zoom === 1} onClick={() => set(1)}>
          Madhësia fillestare
        </Button>
        <span className="ml-auto text-xs text-ink-faint max-sm:hidden">Zmadhoni me rrotën e miut ose me dy klikime; tërhiqeni fotografinë për ta lëvizur.</span>
      </div>
    </div>
  );
}
