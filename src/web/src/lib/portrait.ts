/**
 * Makes a portrait small enough to send: its long side at most 640 pixels, written as JPEG at the best
 * quality that stays under the server's 400 kB limit. A transparent background becomes white.
 */
const LONG_SIDE = 640;
const MAX_BASE64 = Math.floor((400_000 * 4) / 3) - 16;

export async function portrait(file: File): Promise<{ contentType: "image/jpeg"; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no canvas");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let data = "";
  for (const quality of [0.88, 0.78, 0.66, 0.54]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    data = url.slice(url.indexOf(",") + 1);
    if (data.length <= MAX_BASE64) break;
  }
  return { contentType: "image/jpeg", data };
}
