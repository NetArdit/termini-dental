import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isWholePicture } from "../src/server/imageCheck";

// The check that a file is, to its last byte, one picture of the kind it claims (src/server/imageCheck.ts).

const segment = (marker: number, body: number[]) => Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
/** The structure of a JPEG file: what the check walks. The pixels inside are not a real picture. */
function jpeg(scanData: number[] = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    segment(0xdb, new Array(65).fill(1)),
    segment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]),
    segment(0xc4, new Array(20).fill(0)),
    segment(0xda, [1, 1, 0, 0, 63, 0]),
    Buffer.from(scanData),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const webp = readFileSync(new URL("../src/web/public/media/rentgen-800.webp", import.meta.url));

/** A PNG with the given header fields and a few bytes of data; every checksum right. */
function png(width: number, height: number, depth = 8, colour = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([depth, colour, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.alloc(16))), chunk("IEND", Buffer.alloc(0))]);
}

/** A WebP container around one chunk. */
function riff(name: string, body: number[], pad = 0): Buffer {
  const chunk = Buffer.concat([Buffer.from(name), Buffer.from([body.length & 0xff, (body.length >> 8) & 0xff, 0, 0]), Buffer.from(body), body.length % 2 ? Buffer.from([pad]) : Buffer.alloc(0)]);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(chunk.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, chunk]);
}
const vp8 = (width: number, height: number, extra: number[] = []) => riff("VP8 ", [0x10, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8, ...extra]);

describe("a whole picture and nothing else", () => {
  it("takes the demo X-ray photograph, which is a real WebP file small enough to be stored", () => {
    expect(isWholePicture(webp, "image/webp")).toBe(true);
    expect(webp.length).toBeLessThanOrEqual(1_048_576);
  });

  it("takes a JPEG whose scan holds stuffed bytes and restart markers, also a progressive one with two scans", () => {
    expect(isWholePicture(jpeg(), "image/jpeg")).toBe(true);
    const twoScans = Buffer.concat([jpeg().subarray(0, jpeg().length - 2), segment(0xda, [1, 1, 0, 1, 5, 0]), Buffer.from([0x77, 0x88, 0xff, 0xd9])]);
    expect(isWholePicture(twoScans, "image/jpeg")).toBe(true);
  });

  it("refuses a picture that declares a size no visit's picture has, in each of the three formats", () => {
    expect(isWholePicture(png(1600, 1200), "image/png")).toBe(true);
    expect(isWholePicture(png(100_000, 100_000), "image/png")).toBe(false);
    expect(isWholePicture(png(8001, 10), "image/png")).toBe(false);
    expect(isWholePicture(png(7000, 7000), "image/png"), "each side allowed, together too many pixels").toBe(false);
    expect(isWholePicture(png(0, 10), "image/png")).toBe(false);
    expect(isWholePicture(png(10, 10, 3, 2), "image/png"), "a depth the colour type does not have").toBe(false);

    const frame = (height: number, width: number) => segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
    const withFrame = (f: Buffer) => Buffer.concat([Buffer.from([0xff, 0xd8]), f, segment(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from([0x12, 0x34, 0xff, 0xd9])]);
    expect(isWholePicture(withFrame(frame(1200, 1600)), "image/jpeg")).toBe(true);
    expect(isWholePicture(withFrame(frame(60000, 60000)), "image/jpeg")).toBe(false);
    expect(isWholePicture(withFrame(frame(0, 1600)), "image/jpeg"), "the height left for later").toBe(false);
    expect(isWholePicture(withFrame(Buffer.concat([frame(8, 8), frame(8, 8)])), "image/jpeg"), "two frames").toBe(false);
    // DNL after the scan.
    expect(isWholePicture(Buffer.concat([Buffer.from([0xff, 0xd8]), frame(8, 8), segment(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from([0x12]), segment(0xdc, [0, 8]), Buffer.from([0xff, 0xd9])]), "image/jpeg")).toBe(false);

    expect(isWholePicture(vp8(1600, 1200), "image/webp")).toBe(true);
    expect(isWholePicture(vp8(16000, 16000), "image/webp")).toBe(false);
    expect(isWholePicture(vp8(0, 10), "image/webp")).toBe(false);
    // A byte of padding that is not zero, and an animation.
    expect(isWholePicture(vp8(16, 16, [7]), "image/webp")).toBe(true);
    const padded = vp8(16, 16, [7]);
    padded[padded.length - 1] = 1;
    expect(isWholePicture(padded, "image/webp")).toBe(false);
    expect(isWholePicture(riff("ANMF", new Array(24).fill(0)), "image/webp")).toBe(false);
  });

  it("refuses a file of one kind under the name of another", () => {
    expect(isWholePicture(webp, "image/jpeg")).toBe(false);
    expect(isWholePicture(webp, "image/png")).toBe(false);
    expect(isWholePicture(jpeg(), "image/webp")).toBe(false);
    expect(isWholePicture(jpeg(), "image/png")).toBe(false);
  });

  it("refuses anything after the end, a file cut short, and lengths that point outside it", () => {
    const tail = Buffer.from("<script>alert(1)</script>");
    for (const [bytes, type] of [[webp, "image/webp"], [jpeg(), "image/jpeg"]] as const) {
      expect(isWholePicture(Buffer.concat([bytes, tail]), type), `${type} with a tail`).toBe(false);
      expect(isWholePicture(Buffer.concat([bytes, Buffer.from([0])]), type), `${type} with one byte more`).toBe(false);
      expect(isWholePicture(bytes.subarray(0, bytes.length - 3), type), `${type} cut short`).toBe(false);
      expect(isWholePicture(bytes.subarray(0, 12), type), `${type}, the beginning only`).toBe(false);
    }
    // A JPEG with no picture in it: a beginning and an end.
    expect(isWholePicture(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBe(false);
    // A segment that claims to be longer than the file.
    expect(isWholePicture(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), Buffer.alloc(40)]), "image/jpeg")).toBe(false);
    // A WebP whose stated length is not the file's.
    const lying = Buffer.from(webp);
    lying.writeUInt32LE(webp.length, 4);
    expect(isWholePicture(lying, "image/webp")).toBe(false);
    expect(isWholePicture(Buffer.alloc(0), "image/png")).toBe(false);
    expect(isWholePicture(Buffer.from("RIFF....WEBP and then words"), "image/webp")).toBe(false);
  });
});
