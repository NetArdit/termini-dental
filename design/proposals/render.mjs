// Renders the proposal mock-ups in this folder to PNG, at a desktop and a phone width.
//   node design/proposals/render.mjs
// Headless Edge or Chrome over the DevTools Protocol, no dependencies (Node 22+).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9355;
const BROWSERS = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"];
const SHOTS = [
  ["calendar.html", "calendar-desktop.png", 1366, 900],
  ["calendar.html", "calendar-mobile.png", 390, 844],
  ["landing.html", "landing-desktop.png", 1366, 900],
  ["landing.html", "landing-mobile.png", 390, 844],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error("No Edge or Chrome found.");
const profile = mkdtempSync(path.join(tmpdir(), "termini-render-"));
const proc = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 240 && !ws; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    if (res.ok) {
      ws = new WebSocket((await res.json()).webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      });
    }
  } catch {
    await sleep(250);
  }
}
if (!ws) throw new Error("The browser did not open its debugging port.");
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) pending.get(msg.id)?.(msg.result);
});
const send = (method, params = {}) => new Promise((resolve) => (pending.set(++id, resolve), ws.send(JSON.stringify({ id, method, params }))));

try {
  await send("Page.enable");
  for (const [file, out, width, height] of SHOTS) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    await send("Page.navigate", { url: pathToFileURL(path.join(HERE, file)).href });
    await sleep(1500);
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(path.join(HERE, out), Buffer.from(data, "base64"));
    console.log(out);
  }
} finally {
  proc.kill();
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold a file */
  }
  process.exit(0);
}
