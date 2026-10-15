// Is this file, from its first byte to its last, a picture of the kind it claims to be?
//
// The first bytes alone say little: a file can begin as a PNG and carry anything behind it. Here the whole
// structure is walked, as the format lays it out, and the file must END where its format says it ends:
// nothing may follow. That rules out a picture with something else glued on, and a text that merely starts
// with the right letters.
//
// The size the file declares is read too, and held to a ceiling: a few hundred bytes can declare a picture
// of a hundred thousand pixels a side, and whatever opens it would then try to make room for that.
//
// What it does not do: decode the pixels. A file that passes is well formed and of a sane size, not
// necessarily a picture a browser can draw; it is served only as its own type, with nosniff, into an <img>.
// Refused although some programs write them: a JPEG with a second picture after its end (the "MPO" files of
// some phones), a JPEG that states its height after the scan (DNL), an animated WebP, a PNG with anything
// after its end. The page re-draws every picture as a plain JPEG before sending it, so these do not arise
// from the page.

/** The longest side and the most pixels a stored picture may declare. The page sends 1600 at most. */
const MAX_SIDE = 8000;
const MAX_PIXELS = 24_000_000;
const saneSize = (width: number, height: number) => width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Width, height, and the few combinations of depth and colour type the format allows. */
function sanePngHeader(h: Buffer): boolean {
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  const [depth, colour, compression, filter, interlace] = [h[8]!, h[9]!, h[10]!, h[11]!, h[12]!];
  return saneSize(h.readUInt32BE(0), h.readUInt32BE(4)) && (depths[colour]?.includes(depth) ?? false) && compression === 0 && filter === 0 && interlace <= 1;
}

/** Signature, then chunks (length, name, data, checksum), IHDR first, IEND last, and nothing after it. */
function wholePng(bytes: Buffer): boolean {
  if (bytes.length < 8 + 25 + 12 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let at = 8;
  let first = true;
  let data = false;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > bytes.length) return false;
    const name = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(name)) return false;
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) return false;
    if (first !== (name === "IHDR")) return false;
    if (name === "IHDR" && (length !== 13 || !sanePngHeader(bytes.subarray(at + 8, at + 21)))) return false;
    if (name === "IDAT") data = true;
    if (name === "IEND") return length === 0 && data && end === bytes.length;
    first = false;
    at = end;
  }
  return false;
}

/** SOI, then segments with their lengths, the compressed scans, EOI, and nothing after it. */
function wholeJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let at = 2;
  let frame = false;
  let scan = false;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return false;
    // A marker may be preceded by any number of fill bytes.
    while (bytes[at + 1] === 0xff) at += 1;
    const marker = bytes[at + 1];
    if (marker === undefined) return false;
    at += 2;
    if (marker === 0xd9) return frame && scan && at === bytes.length;
    // DC is DNL, "the height follows after the scan": a frame must say its own size here.
    if (marker === 0x00 || marker === 0xd8 || marker === 0xdc) return false;
    // Markers that stand alone.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) return false;
    // A start of frame (baseline, progressive and the rest; C4, C8 and CC are tables, not frames).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // Length, precision, height, width, number of components: one frame, of a sane size.
      if (frame || length < 8 || !saneSize(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3))) return false;
      frame = true;
    }
    at += length;
    if (marker === 0xda) {
      scan = true;
      // The compressed data runs to the next real marker: FF followed by neither 00 nor a restart marker.
      for (;;) {
        const next = bytes.indexOf(0xff, at);
        if (next < 0 || next + 1 >= bytes.length) return false;
        const after = bytes[next + 1]!;
        if (after === 0x00 || (after >= 0xd0 && after <= 0xd7)) {
          at = next + 2;
        } else if (after === 0xff) {
          at = next + 1;
        } else {
          at = next;
          break;
        }
      }
    }
  }
  return false;
}

/** RIFF, the length of everything after it (which must be the rest of the file), WEBP, chunks to the end. */
function wholeWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WEBP") return false;
  if (bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  let at = 12;
  let first = true;
  let picture = false;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return false;
    const name = bytes.subarray(at, at + 4).toString("latin1");
    const length = bytes.readUInt32LE(at + 4);
    // A chunk of odd length is followed by one byte of padding.
    const end = at + 8 + length + (length % 2);
    if (end > bytes.length) return false;
    if (first && !["VP8 ", "VP8L", "VP8X"].includes(name)) return false;
    // The byte that evens out an odd chunk is zero, by the container's rule.
    if (length % 2 && bytes[end - 1] !== 0) return false;
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (name === "VP8X") {
      // Flags, three reserved bytes, then width and height, each less one, in three bytes.
      if (!first || length < 10 || !saneSize(body.readUIntLE(4, 3) + 1, body.readUIntLE(7, 3) + 1)) return false;
    } else if (name === "VP8 ") {
      // A key frame: three bytes of tag, the start code 9D 01 2A, then 14 bits of width and of height.
      if (picture || length < 10 || body[0]! & 1 || body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) return false;
      if (!saneSize(body.readUInt16LE(6) & 0x3fff, body.readUInt16LE(8) & 0x3fff)) return false;
      picture = true;
    } else if (name === "VP8L") {
      // The signature 2F, then 14 bits of width less one and 14 of height less one.
      if (picture || length < 5 || body[0] !== 0x2f) return false;
      const bits = body.readUInt32LE(1);
      if (!saneSize((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)) return false;
      picture = true;
    } else if (name === "ANIM" || name === "ANMF") {
      // An animation is not a picture of a visit.
      return false;
    }
    first = false;
    at = end;
  }
  return picture;
}

export type PictureType = "image/jpeg" | "image/png" | "image/webp";

/** True only when the whole of `bytes` is one well-formed file of that type, with nothing after its end. */
export function isWholePicture(bytes: Buffer, contentType: PictureType): boolean {
  try {
    if (contentType === "image/png") return wholePng(bytes);
    if (contentType === "image/jpeg") return wholeJpeg(bytes);
    return wholeWebp(bytes);
  } catch {
    // A length that points outside the file, in a place not checked above.
    return false;
  }
}
