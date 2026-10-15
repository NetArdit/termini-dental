import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { Ctx } from "../src/server/context";

// How the built web app reaches the browser: compressed, and cached for as long as each file allows.
// No database: a file request must not need one, and this stand-in fails loudly if anything asks.

const SCRIPT = `console.log(${JSON.stringify("termini ".repeat(600))});`;
let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "termini-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Termini Dental</title><div id=root></div>");
  writeFileSync(path.join(dir, "assets", "index-abc123.js"), SCRIPT);
  writeFileSync(path.join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const refuse = () => Promise.reject(new Error("a static file asked the database for something"));
  const ctx: Ctx = { db: { query: refuse, tx: refuse, migrate: refuse, close: async () => {} }, now: () => new Date(), mailer: null, publicUrl: "http://test.local", webDir: dir };
  server = await new Promise((resolve) => {
    const s = createApp(ctx).listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

// fetch would decompress silently; asking with an explicit header and reading the raw length shows what
// really travelled.
const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers });

describe("serving the web app", () => {
  it("sends content-named assets compressed and cacheable for a year", async () => {
    const res = await get("/assets/index-abc123.js", { "accept-encoding": "gzip", cookie: "td_session=whatever" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(await res.text()).toBe(SCRIPT);
  });

  it("sends them as they are to a client that cannot take compression", async () => {
    const res = await get("/assets/index-abc123.js", { "accept-encoding": "identity" });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(SCRIPT));
  });

  it("answers 404, not the page, for an asset that does not exist", async () => {
    const res = await get("/assets/index-old999.js");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<!doctype html>");
  });

  it("always has the page itself checked with the server, on every route of the app", async () => {
    for (const route of ["/", "/rezervo", "/app/kalendari"]) {
      const res = await get(route);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<!doctype html>");
    }
  });

  it("keeps other files for an hour and patient data out of every cache", async () => {
    expect((await get("/favicon.svg")).headers.get("cache-control")).toBe("public, max-age=3600");
    const api = await get("/api/auth/me");
    expect(api.status).toBe(401);
    expect(api.headers.get("cache-control")).toBe("no-store");
  });
});
