/**
 * Read-only screen and flow audit in a real browser (Edge or Chrome, headless). No dependencies: it speaks the
 * Chrome DevTools Protocol over Node's built-in WebSocket (Node 22+).
 *
 *   node e2e/screen-audit.mjs [baseUrl]
 *
 * Run it against the built app with the demo seed in an ISOLATED database directory, never the shared one
 * and never the hosted one. The empty DATABASE_URL matters: without it, a .env that names a hosted database
 * wins and the run (the write flows included) would go there.
 *   DATABASE_URL= PGLITE_DIR=<empty dir> npm run seed
 *   DATABASE_URL= PGLITE_DIR=<same dir> PORT=3950 npm start
 *
 * It changes nothing in the app's data: it logs in, looks, presses keys and measures. Screenshots and
 * report.json go to e2e/artifacts/ (git-ignored). Only the synthetic demo accounts are used.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] ?? "http://127.0.0.1:3950").replace(/\/$/, "");
const OUT = path.join(HERE, "artifacts");
const DEBUG_PORT = 9344;
/**
 * SECTIONS picks the parts to run: screens, checks (keyboard and stale answer), perf (default: these three),
 * and flows (book, cancel, add a patient, save a report: these WRITE, so only on a scratch database).
 * ONLY_VIEWPORT=desktop|mobile limits the screens part. A small machine cannot hold the whole run at once,
 * so each part can be run on its own and writes its own report file. PERF_ONLY=1 is short for SECTIONS=perf.
 */
const PERF_ONLY = process.env.PERF_ONLY === "1";
const SECTIONS = new Set((PERF_ONLY ? "perf" : process.env.SECTIONS || "screens,checks,perf").split(","));
const SCREEN_VIEWPORTS = SECTIONS.has("screens") ? ["desktop", "mobile"].filter((v) => !process.env.ONLY_VIEWPORT || v === process.env.ONLY_VIEWPORT) : [];
const PERF_RUNS = Number(process.env.PERF_RUNS || 3);
// A demo clinic that is reachable from outside is seeded with a password of its own (DEMO_PASSWORD).
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "demo12345";
const ADMIN = { email: "arta@demo.test", password: DEMO_PASSWORD };
const DENTIST = { email: "besnik@demo.test", password: DEMO_PASSWORD };
const VIEWPORTS = { desktop: { width: 1366, height: 768, mobile: false }, mobile: { width: 390, height: 844, mobile: true } };

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(event, fn) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
}

async function launch() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error("No Edge or Chrome found; add its path to BROWSERS.");
  const profile = mkdtempSync(path.join(tmpdir(), "termini-audit-"));
  const proc = spawn(exe, [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" });
      if (res.ok) {
        const target = await res.json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve);
          ws.addEventListener("error", reject);
        });
        return { cdp: new Cdp(ws), proc, profile, exe };
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error("The browser did not open its debugging port.");
}

const { cdp, proc, profile, exe } = await launch();
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, browser: "", startedAt: new Date().toISOString(), pages: [], keyboard: {}, stale: {}, performance: [], notes: [] };

let consoleErrors = [];
/** Requests of the current measurement: requestId -> { url, type, status, encoding, bytes }. */
let requests = new Map();
/** The calendar view a login leaves the browser in: the checks and flows below were written for the list. */
let calendarView = "lista";
/** Appointments on the calendar page, in either view: rows of the list, or blocks of the timetable. */
const APPOINTMENTS = `[...document.querySelectorAll('main ul li button, main section[aria-label] button[aria-label*=", "]')]`;
/** When set, the first matching API response is held back this long (for the stale-answer check). */
let delayOnce = null;
/** Calls to /api/auth/me since the last inspected screen: the patient's pages should make none. */
let sessionProbes = 0;
/** Requests that change something, since the stale-answer check began: it must cause none. */
let writes = [];
/** Id of the appointment whose details were last asked for: the one a dialog is showing. */
let lastAppointmentId = 0;
/** Set when a flow fails or the run stops early: the process then ends with a failing status. */
let failed = false;

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Network.enable");
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/appointments/*", requestStage: "Request" }] });
report.browser = (await cdp.send("Browser.getVersion")).product;

cdp.on("Log.entryAdded", ({ entry }) => {
  if (entry.level === "error") consoleErrors.push(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
});
cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => consoleErrors.push(`exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`));
cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
  requests.set(requestId, { url: response.url, type, status: response.status, encoding: response.headers["content-encoding"] ?? response.headers["Content-Encoding"] ?? "none", cache: response.headers["cache-control"] ?? response.headers["Cache-Control"] ?? "", bytes: 0 });
});
// API requests that have been sent and not yet answered. On a host an answer takes a second, not a few
// milliseconds: "the page has settled" must mean that nothing is still on its way.
const inflight = new Set();
cdp.on("Network.loadingFailed", ({ requestId }) => inflight.delete(requestId));
cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
  if (request.url.includes("/api/")) inflight.add(requestId);
  if (request.url.endsWith("/api/auth/me")) sessionProbes += 1;
  const detail = request.method === "GET" && /\/api\/appointments\/(\d+)$/.exec(request.url);
  if (detail) lastAppointmentId = Number(detail[1]);
  if (request.method !== "GET" && request.url.includes("/api/")) writes.push(`${request.method} ${request.url.replace(BASE, "")}`);
});
cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
  inflight.delete(requestId);
  const r = requests.get(requestId);
  if (r) r.bytes = encodedDataLength;
});
cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
  try {
    if (delayOnce && delayOnce.test(request.url)) {
      const ms = delayOnce.ms;
      delayOnce = null;
      await sleep(ms);
    }
    await cdp.send("Fetch.continueRequest", { requestId });
  } catch {
    /* the page moved on */
  }
});

async function evaluate(expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  return res.result.value;
}

/** Waits until the page has loaded, no spinner is left and no API request is still unanswered. */
async function settle(extraMs = 350) {
  // A click that causes a request needs a moment to send it.
  await sleep(120);
  for (let i = 0; i < 160; i++) {
    const ready = inflight.size === 0 && await evaluate(`document.readyState === "complete" && !document.querySelector('[role="status"]') && document.getElementById("root")?.childElementCount > 0`).catch(() => false);
    if (ready) break;
    await sleep(150);
  }
  await sleep(extraMs);
}

async function go(pathname) {
  await cdp.send("Page.navigate", { url: BASE + pathname });
  await settle();
}

async function viewport(name) {
  const v = VIEWPORTS[name];
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: v.mobile });
}

async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}

async function key(k, code, vk, modifiers = 0) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(60);
}
const tab = () => key("Tab", "Tab", 9);

async function clickAt(selectorJs) {
  const box = await evaluate(`(() => { const el = ${selectorJs}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(120);
  return true;
}

async function typeInto(selectorJs, text) {
  await evaluate(`(${selectorJs}).focus()`);
  await cdp.send("Input.insertText", { text });
}

async function login(account) {
  await cdp.send("Network.clearBrowserCookies");
  await go("/kycu");
  await typeInto(`document.querySelector('input[type="email"]')`, account.email);
  await typeInto(`document.querySelector('input[type="password"]')`, account.password);
  await key("Enter", "Enter", 13);
  // Enter on a field submits the form through the browser's implicit submission.
  await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
  // Up to twenty seconds: on a machine short of memory the first login after a cold start can take that long.
  for (let i = 0; i < 130 && !(await evaluate(`location.pathname.startsWith("/app")`)); i++) await sleep(150);
  await evaluate(`localStorage.setItem("termini.calendar.view", ${JSON.stringify(calendarView)})`).catch(() => {});
  await settle();
  return evaluate(`location.pathname`);
}

const describeActive = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "(body)";
  const name = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute("placeholder") || el.value || "";
  const style = getComputedStyle(el);
  const ring = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? "outline" : style.boxShadow !== "none" ? "ring" : "NO-INDICATOR";
  return el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "") + (el.getAttribute("role") ? "(" + el.getAttribute("role") + ")" : "") + " \\"" + name.trim().replace(/\\s+/g, " ").slice(0, 40) + "\\" " + ring + (el.closest("dialog") ? " in-dialog" : "");
})()`;

/** What can be measured on a rendered screen without a human: overflow, names, labels, targets, contrast. */
const INSPECT = `(() => {
  const vw = window.innerWidth;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const label = (el) => (el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(/\\s+/).slice(0, 3).join(".") : "") + " \\"" + (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 40) + "\\"");
  const all = [...document.querySelectorAll("body *")].filter(visible);
  // Horizontal overflow: the page scrolls sideways, or something sticks out of the viewport without being
  // inside a container that scrolls on purpose.
  const scrollsOnPurpose = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true; } return false; };
  const sticking = all.filter((el) => el.getBoundingClientRect().right > vw + 1 && !scrollsOnPurpose(el)).slice(0, 5).map(label);
  // Clipped text: content wider than its box in a box that hides the excess (truncate is a choice; listed for review).
  const truncated = all.filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === "ellipsis").slice(0, 8).map(label);
  const interactive = [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [role="button"], [role="tab"]')].filter(visible);
  const accName = (el) => (el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") && document.getElementById(el.getAttribute("aria-labelledby"))?.innerText) || (el.labels && [...el.labels].map((l) => l.innerText).join(" ")) || el.innerText || el.getAttribute("title") || el.getAttribute("alt") || "").trim();
  const unnamed = interactive.filter((el) => !accName(el) && el.type !== "hidden").map(label);
  const small = interactive.filter((el) => { const r = el.getBoundingClientRect(); return (r.width < 24 || r.height < 24) && el.type !== "checkbox" && el.type !== "radio"; }).map(label);
  // What a finger can hit. A checkbox or radio button inside a label is pressed through the label, so the
  // label is its target; one without a label is measured as it is. Links inside a sentence are text.
  const target = (el) => ((el.type === "checkbox" || el.type === "radio") && el.closest("label") ? el.closest("label") : el);
  const under44List = interactive.filter((el) => { const r = target(el).getBoundingClientRect(); return r.height < 44 && getComputedStyle(el).display !== "inline"; });
  const under44 = under44List.length;
  const under44Which = under44List.slice(0, 8).map(label);
  // Contrast of every piece of text against the nearest opaque background behind it.
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const background = (el) => { const layers = []; for (let p = el; p; p = p.parentElement) { const c = parse(getComputedStyle(p).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; } } let out = { r: 255, g: 255, b: 255, a: 1 }; for (const c of layers.reverse()) out = over(c, out); return out; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const low = new Map();
  for (const el of all) {
    const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
    if (!text) continue;
    const s = getComputedStyle(el);
    const fg0 = parse(s.color); if (!fg0) continue;
    const bg = background(el); const fg = over(fg0, bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(s.fontSize); const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight) >= 700);
    const disabled = el.closest(":disabled") !== null;
    if (ratio < (large ? 3 : 4.5) && !disabled) { const k = hex(fg) + " on " + hex(bg); if (!low.has(k)) low.set(k, { pair: k, ratio: Math.round(ratio * 100) / 100, px: size, sample: text.slice(0, 40) }); }
  }
  return {
    title: document.title,
    h1: [...document.querySelectorAll("h1")].filter(visible).map((h) => h.innerText.trim()),
    pageScrollsSideways: document.documentElement.scrollWidth > vw + 1,
    scrollWidth: document.documentElement.scrollWidth,
    sticking, truncated, unnamed, small, under44, under44Which, interactive: interactive.length,
    lowContrast: [...low.values()],
    landmarks: { main: document.querySelectorAll("main").length, nav: document.querySelectorAll("nav").length, header: document.querySelectorAll("header").length },
    text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 160),
  };
})()`;

/**
 * Refuses to go on unless the server under test runs on the demo seed: the flows write, and the screens
 * log in with the demo accounts. Only a database made by the seed has those accounts: a real clinic's
 * administrator is not "arta@demo.test" with the demo password.
 */
async function requireDemoServer() {
  const clinic = await fetch(`${BASE}/api/public/clinic`).catch(() => null);
  const login = clinic?.status === 200 ? await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "termini" }, body: JSON.stringify(ADMIN) }).catch(() => null) : null;
  if (!login || login.status !== 200) throw new Error(`${BASE} is not serving the demo clinic (clinic ${clinic?.status ?? "none"}, demo login ${login?.status ?? "not tried"}). Start a scratch server: DATABASE_URL= PGLITE_DIR=<empty dir> npm run seed, then npm start.`);
}

async function inspect(name, who, vp) {
  const data = await evaluate(INSPECT);
  report.pages.push({ name, who, viewport: vp, path: await evaluate("location.pathname"), ...data, consoleErrors, sessionProbes });
  consoleErrors = [];
  sessionProbes = 0;
  await shot(`${vp}-${who}-${name}`);
  const flags = [data.pageScrollsSideways ? "SIDEWAYS-SCROLL" : "", data.sticking.length ? `sticking:${data.sticking.length}` : "", data.unnamed.length ? `unnamed:${data.unnamed.length}` : "", data.lowContrast.length ? `contrast:${data.lowContrast.length}` : "", data.small.length ? `small:${data.small.length}` : ""].filter(Boolean).join(" ");
  console.log(`${vp.padEnd(7)} ${who.padEnd(7)} ${name.padEnd(22)} ${flags || "ok"}`);
}

/** The first weekday that has appointments in the demo data: the calendar opens on today, which may be empty. */
async function openBusyDay(atLeast = 2) {
  for (let i = 0; i < 6; i++) {
    const rows = await evaluate(`${APPOINTMENTS}.length`);
    if (rows >= atLeast) return rows;
    await clickAt(`document.querySelector('button[aria-label="Dita tjetër"]')`);
    await settle(250);
  }
  return evaluate(`${APPOINTMENTS}.length`);
}

const STAFF_PAGES = [
  ["kalendari", "/app/kalendari"],
  ["raportet", "/app/raportet"],
  ["pacientet", "/app/pacientet"],
  ["kontrolle", "/app/kontrolle"],
  ["emailat", "/app/emailat"],
  ["cilesimet", "/app/cilesimet"],
];

try {
  await requireDemoServer();
  // ---- 1. every screen, both viewports, both roles ---------------------------------------------------
  for (const vp of SCREEN_VIEWPORTS) {
    await viewport(vp);
    await cdp.send("Network.clearBrowserCookies");
    for (const [name, p] of [["landing", "/"], ["booking", "/rezervo"], ["login", "/kycu"], ["bad-link", "/termin#nuk-ekziston"]]) {
      await go(p);
      await inspect(name, "public", vp);
    }
    // The booking page with every step open.
    await go("/rezervo");
    await clickAt(`[...document.querySelectorAll("main button[aria-pressed]")][0]`);
    await sleep(200);
    await clickAt(`[...document.querySelectorAll("main button[aria-pressed]")].find((b) => b.innerText.includes("Kushdo"))`);
    await settle(500);
    await clickAt(`[...document.querySelectorAll("main button[aria-pressed]")].find((b) => /^\\d{2}:\\d{2}$/.test(b.innerText.trim()))`);
    await sleep(300);
    await inspect("booking-all-steps", "public", vp);

    for (const [who, account] of [["admin", ADMIN], ["dentist", DENTIST]]) {
      calendarView = "orari";
      const landed = await login(account);
      if (!landed.startsWith("/app")) {
        report.notes.push(`${vp}: login as ${who} did not reach /app (stayed on ${landed})`);
        continue;
      }
      for (const [name, p] of STAFF_PAGES) {
        await go(p);
        if (name === "kalendari") {
          // The timetable first (the default), then the same day as a list.
          await openBusyDay(who === "admin" ? 2 : 1);
          await inspect("kalendari-orari", who, vp);
          await clickAt(`[...document.querySelectorAll('[aria-label="Pamja e kalendarit"] button')].find((b) => b.innerText.trim() === "Lista")`);
          await settle(300);
          await inspect("kalendari-lista", who, vp);
          continue;
        }
        await inspect(name, who, vp);
      }
      // A patient's page and an open appointment dialog.
      await go("/app/pacientet");
      if (await clickAt(`document.querySelector('main a[href^="/app/pacientet/"]')`)) {
        await settle();
        await inspect("pacient-detaj", who, vp);
      } else report.notes.push(`${vp} ${who}: no patient link found on the patients page`);
      await go("/app/kalendari");
      await openBusyDay(1);
      if (await clickAt(`${APPOINTMENTS}[0]`)) {
        await settle(500);
        await inspect("termin-dialog", who, vp);
        await key("Escape", "Escape", 27);
      }
      if (who === "admin") {
        await go("/app/cilesimet");
        for (const tabName of ["Klinika", "Stafi", "Shërbimet"]) {
          await clickAt(`[...document.querySelectorAll('[role="tab"]')].find((t) => t.innerText.trim() === ${JSON.stringify(tabName)})`);
          await settle(300);
          await inspect(`cilesimet-${tabName.toLowerCase()}`, who, vp);
        }
      }
    }
  }

  if (SECTIONS.has("checks")) {
  calendarView = "lista";
  // ---- 2. keyboard -----------------------------------------------------------------------------------
  await viewport("desktop");
  await cdp.send("Network.clearBrowserCookies");
  await go("/rezervo");
  const order = [];
  for (let i = 0; i < 12; i++) {
    await tab();
    order.push(await evaluate(describeActive));
  }
  report.keyboard.bookingTabOrder = order;
  // Choose a service with the keyboard alone: does the next step appear and does focus stay sensible?
  await evaluate(`[...document.querySelectorAll("main button[aria-pressed]")][0].focus()`);
  await key(" ", "Space", 32);
  await cdp.send("Input.dispatchKeyEvent", { type: "char", text: " " });
  await sleep(300);
  report.keyboard.bookingSpaceSelects = await evaluate(`[...document.querySelectorAll("main button[aria-pressed]")][0].getAttribute("aria-pressed")`);
  report.keyboard.bookingFocusAfterSelect = await evaluate(describeActive);

  await login(ADMIN);
  await go("/app/cilesimet");
  await evaluate(`document.querySelector('[role="tab"]').focus()`);
  const before = await evaluate(describeActive);
  await key("ArrowRight", "ArrowRight", 39);
  report.keyboard.settingsTabs = {
    before,
    afterArrowRight: await evaluate(describeActive),
    tabpanels: await evaluate(`document.querySelectorAll('[role="tabpanel"]').length`),
    ariaControls: await evaluate(`[...document.querySelectorAll('[role="tab"]')].filter((t) => t.getAttribute("aria-controls")).length`),
    tabsInTabOrder: await evaluate(`[...document.querySelectorAll('[role="tab"]')].filter((t) => t.tabIndex === 0).length`),
  };

  await go("/app/kalendari");
  const rowCount = await openBusyDay();
  // The row may still be on its way on a slow machine: wait for it before giving it the focus.
  for (let i = 0; i < 50 && !(await evaluate(`Boolean(document.querySelector("main ul li button"))`)); i++) await sleep(200);
  await evaluate(`document.querySelector("main ul li button").focus()`);
  const trigger = await evaluate(describeActive);
  await key("Enter", "Enter", 13);
  await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
  await settle(500);
  const dialog = {
    rowsOnDay: rowCount,
    trigger,
    openedByEnter: await evaluate(`Boolean(document.querySelector("dialog[open]"))`),
    focusOnOpen: await evaluate(describeActive),
    labelledBy: await evaluate(`(() => { const d = document.querySelector("dialog[open]"); return d ? (d.getAttribute("aria-labelledby") || d.getAttribute("aria-label") || "NONE") : "no dialog"; })()`),
  };
  const inside = [];
  for (let i = 0; i < 8; i++) {
    await tab();
    inside.push(await evaluate(describeActive));
  }
  dialog.tabOrder = inside;
  dialog.focusLeftDialog = inside.some((d) => !d.includes("in-dialog") && d !== "(body)");
  await key("Escape", "Escape", 27);
  await sleep(300);
  dialog.closedByEscape = await evaluate(`!document.querySelector("dialog[open]")`);
  dialog.focusAfterClose = await evaluate(describeActive);
  report.keyboard.appointmentDialog = dialog;

  // ---- 2b. the timetable view ------------------------------------------------------------------------
  {
    const t = {};
    await evaluate(`localStorage.setItem("termini.calendar.view", "orari")`);
    await go("/app/kalendari");
    await openBusyDay(2);
    t.columns = await evaluate(`[...document.querySelectorAll("main section[aria-label]")].map((s) => s.getAttribute("aria-label"))`);
    t.weekStrip = await evaluate(`[...document.querySelectorAll('[aria-label="Java"] button')].map((b) => b.getAttribute("aria-label"))`);
    t.blocks = await evaluate(`[...document.querySelectorAll('main section[aria-label] button[aria-label*=", "]')].map((b) => ({ label: b.getAttribute("aria-label"), top: Math.round(b.getBoundingClientRect().top - b.parentElement.getBoundingClientRect().top), height: Math.round(b.getBoundingClientRect().height) }))`);
    t.hourMarks = await evaluate(`[...document.querySelectorAll("main .tabular-nums.text-ink-faint")].map((e) => e.innerText.trim())`);
    // A block sits at (its start minus the first hour) pixels: one pixel a minute.
    t.blocksAtTheirTime = await evaluate(`(() => { const first = document.querySelector("main .tabular-nums.text-ink-faint").innerText.trim(); const [h, m] = first.split(":").map(Number); return [...document.querySelectorAll('main section[aria-label] button[aria-label*=", "]')].every((b) => { const [bh, bm] = b.getAttribute("aria-label").slice(0, 5).split(":").map(Number); const want = bh * 60 + bm - (h * 60 + m); const got = b.getBoundingClientRect().top - b.parentElement.getBoundingClientRect().top; return Math.abs(got - want) <= 2; }); })()`);
    t.freeStretches = await evaluate(`[...document.querySelectorAll('main section[aria-label] button[aria-label^="Cakto termin"]')].map((b) => b.getAttribute("aria-label"))`);
    // Booking from a free stretch: the dialog opens on that dentist with that time filled in.
    const free = t.freeStretches[0] ?? "";
    const wantTime = (free.match(/e lirë (\d{2}:\d{2})/) ?? [])[1] ?? "";
    const wantDentist = (free.match(/te (.+?): e lirë/) ?? [])[1] ?? "";
    if (free && (await clickAt(`document.querySelector('main section[aria-label] button[aria-label^="Cakto termin"]')`))) {
      await settle(600);
      t.bookFromFree = {
        stretch: free,
        dialogOpen: await evaluate(`Boolean(document.querySelector("dialog[open]"))`),
        timeFilled: await evaluate(`document.querySelector('dialog[open] input[type="time"]')?.value ?? ""`),
        dentistChosen: await evaluate(`(() => { const sel = [...document.querySelectorAll("dialog[open] select")].find((s) => [...s.options].some((o) => o.text === ${JSON.stringify(wantDentist)})); return sel ? sel.options[sel.selectedIndex].text : ""; })()`),
        wantTime,
        wantDentist,
      };
      await key("Escape", "Escape", 27);
      await sleep(200);
    }
    // The switch: to the list and back, and the choice survives a reload.
    await clickAt(`[...document.querySelectorAll('[aria-label="Pamja e kalendarit"] button')].find((b) => b.innerText.trim() === "Lista")`);
    await settle(300);
    t.listAfterSwitch = await evaluate(`document.querySelectorAll("main ul li button").length`);
    await cdp.send("Page.reload");
    await settle(500);
    t.viewAfterReload = await evaluate(`[...document.querySelectorAll('[aria-label="Pamja e kalendarit"] button')].find((b) => b.getAttribute("aria-pressed") === "true")?.innerText.trim()`);
    t.storedValue = await evaluate(`localStorage.getItem("termini.calendar.view")`);
    t.storedKeys = await evaluate(`Object.keys(localStorage)`);
    const ok = t.columns.length >= 2 && t.weekStrip.length === 7 && t.blocks.length >= 2 && t.blocksAtTheirTime && t.bookFromFree?.dialogOpen && t.bookFromFree.timeFilled === wantTime && t.bookFromFree.dentistChosen === wantDentist && t.listAfterSwitch >= 2 && t.viewAfterReload === "Lista";
    if (!ok) failed = true;
    report.timetable = { ok, ...t };
    console.log(`timetable check: ${ok ? "PASS" : "FAIL"}  (${t.columns.length} columns, ${t.blocks.length} blocks at their time: ${t.blocksAtTheirTime}, ${t.freeStretches.length} free stretches, booking from "${wantTime}" filled "${t.bookFromFree?.timeFilled}", view after reload: ${t.viewAfterReload})`);
    await evaluate(`localStorage.setItem("termini.calendar.view", "lista")`);
  }

  // ---- 3. stale answer in the appointment dialog (UX-02) ---------------------------------------------
  await go("/app/kalendari");
  const rows = await openBusyDay();
  if (rows >= 2) {
    const names = await evaluate(`[...document.querySelectorAll("main ul li button")].slice(0, 2).map((b) => b.querySelector("span.min-w-0 span")?.innerText.trim())`);
    delayOnce = { test: (url) => /\/api\/appointments\/\d+$/.test(url), ms: 2500 };
    writes = [];
    await clickAt(`document.querySelectorAll("main ul li button")[0]`); // A: its answer is held back
    await sleep(200);
    await key("Escape", "Escape", 27);
    await sleep(200);
    await clickAt(`document.querySelectorAll("main ul li button")[1]`); // B: answers at once
    await settle(600);
    const early = await evaluate(`document.querySelector("dialog[open]")?.innerText.replace(/\\s+/g, " ").slice(0, 200) ?? ""`);
    await sleep(3000);
    const late = await evaluate(`document.querySelector("dialog[open]")?.innerText.replace(/\\s+/g, " ").slice(0, 200) ?? ""`);
    // The buttons act on the appointment the dialog holds, so what the dialog links to is what they would hit.
    const recordLink = await evaluate(`document.querySelector('dialog[open] a[href^="/app/pacientet/"]')?.getAttribute("href") ?? ""`);
    report.stale = {
      opened: names,
      expected: names[1],
      showsBAtFirst: early.includes(names[1]),
      showsAAfterLateAnswer: late.includes(names[0]),
      staysOnBAfterLateAnswer: late.includes(names[1]) && !late.includes(names[0]),
      recordLinkAfterLateAnswer: recordLink,
      writesDuringCheck: writes,
      early,
      late,
    };
    console.log(`stale-answer check: ${report.stale.staysOnBAfterLateAnswer && writes.length === 0 ? "PASS" : "FAIL"}  (dialog on "${names[1]}" after the late answer for "${names[0]}": ${report.stale.staysOnBAfterLateAnswer}; writes: ${writes.length})`);
    await shot("stale-dialog");
    await key("Escape", "Escape", 27);
  } else report.stale = { skipped: `only ${rows} appointment rows on the busiest day found` };

  }

  // ---- 3b. the flows that write: book, cancel, add a patient, save a report --------------------------
  // Not part of a default run: these change the database they are pointed at. Run them only against a
  // scratch database with the demo seed:  SECTIONS=flows node e2e/screen-audit.mjs
  if (SECTIONS.has("flows")) {
    report.flows = [];
    const flow = async (name, fn) => {
      try {
        const detail = await fn();
        report.flows.push({ name, ok: true, detail });
        console.log(`flow PASS  ${name}${detail ? `  [${detail}]` : ""}`);
      } catch (err) {
        failed = true;
        report.flows.push({ name, ok: false, detail: String(err instanceof Error ? err.message : err) });
        console.log(`flow FAIL  ${name}  [${err instanceof Error ? err.message : err}]`);
        await shot(`flow-failed-${name.replace(/[^a-z]+/gi, "-")}`).catch(() => {});
      }
    };
    const must = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const until = async (expression, what, ms = 10000) => {
      for (let waited = 0; waited < ms; waited += 200) {
        if (await evaluate(expression).catch(() => false)) return;
        await sleep(200);
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const BY_LABEL = `((text, root = document) => { const l = [...root.querySelectorAll("label")].find((x) => x.innerText.trim().startsWith(text)); return l ? document.getElementById(l.htmlFor) : null; })`;
    const BUTTON = `((text, root = document) => [...root.querySelectorAll("button")].find((b) => b.innerText.trim().includes(text) && !b.disabled))`;
    const api = (pathname, headers = {}) => evaluate(`fetch(${JSON.stringify(pathname)}, { headers: ${JSON.stringify(headers)} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const stamp = Date.now().toString().slice(-6);
    const patient = { name: `Provë Rrjedhe ${stamp}`, phone: "044 555 0" + stamp.slice(-2), email: `prove-${stamp}@example.test` };
    let token = "";

    await viewport("desktop");
    await cdp.send("Network.clearBrowserCookies");

    await flow("a patient books online, start to finish", async () => {
      await go("/rezervo");
      must(await clickAt(`[...document.querySelectorAll("main button[aria-pressed]")][0]`), "no service to choose");
      await sleep(200);
      must(await clickAt(`[...document.querySelectorAll("main button[aria-pressed]")].find((b) => b.innerText.includes("Kushdo"))`), "no 'any dentist' choice");
      await until(`[...document.querySelectorAll("main button[aria-pressed]")].some((b) => /^\\d{2}:\\d{2}$/.test(b.innerText.trim()))`, "free times");
      const time = await evaluate(`[...document.querySelectorAll("main button[aria-pressed]")].find((b) => /^\\d{2}:\\d{2}$/.test(b.innerText.trim())).innerText.trim()`);
      await clickAt(`[...document.querySelectorAll("main button[aria-pressed]")].find((b) => /^\\d{2}:\\d{2}$/.test(b.innerText.trim()))`);
      await until(`Boolean(${BY_LABEL}("Emri dhe mbiemri"))`, "the contact form");
      // The confirm button stays disabled until the notice is accepted (owner's rule 1).
      must(await evaluate(`[...document.querySelectorAll("main button")].find((b) => b.innerText.includes("Konfirmo terminin")).disabled`), "confirm was enabled before the notice was accepted");
      await typeInto(`${BY_LABEL}("Emri dhe mbiemri")`, patient.name);
      await typeInto(`${BY_LABEL}("Telefoni")`, patient.phone);
      await typeInto(`${BY_LABEL}("Email")`, patient.email);
      must((await evaluate(`document.body.innerText`)).includes("klinika mund ta anulojë terminin"), "the cancellation notice is not on the page");
      await clickAt(`document.querySelector('main input[type="checkbox"]')`);
      must(await clickAt(`${BUTTON}("Konfirmo terminin")`), "confirm button not clickable after accepting the notice");
      await until(`document.querySelector("main").innerText.includes("Termini u caktua")`, "the confirmation");
      must((await evaluate(`document.querySelectorAll("h1").length`)) === 1, "the confirmation page has more than one main heading");
      token = (await evaluate(`document.querySelector('a[href^="/termin#"]').getAttribute("href")`)).replace("/termin#", "");
      const saved = await api("/api/public/appointment", { "x-appointment-token": token });
      must(saved.status === 200 && saved.body.appointment.patientName === patient.name, `the booking is not on the server (status ${saved.status})`);
      return `${time}, private link issued`;
    });

    await flow("the patient opens the private link and cancels", async () => {
      must(token, "no booking to cancel (the booking flow failed)");
      await go(`/termin#${token}`);
      must((await evaluate(`document.body.innerText`)).includes(patient.name), "the private page does not show the appointment");
      must(await clickAt(`${BUTTON}("Nuk mund të vij")`), "no cancel button");
      await sleep(200);
      must(await clickAt(`${BUTTON}("Po, anuloje")`), "no confirmation step");
      await until(`document.querySelector("h1")?.innerText.includes("Termini u anulua")`, "the cancelled message");
      const gone = await api("/api/public/appointment", { "x-appointment-token": token });
      must(gone.status === 404, `the link still works after cancelling (status ${gone.status})`);
      return "link dead afterwards";
    });

    must((await login(ADMIN)).startsWith("/app"), "administrator login failed");

    await flow("staff add a patient", async () => {
      await go("/app/pacientet");
      must(await clickAt(`${BUTTON}("Pacient i ri")`), "no 'new patient' button");
      await until(`Boolean(document.querySelector("dialog[open]"))`, "the patient dialog");
      await typeInto(`${BY_LABEL}("Emri dhe mbiemri", document.querySelector("dialog[open]"))`, `${patient.name} Lokal`);
      await typeInto(`${BY_LABEL}("Telefoni", document.querySelector("dialog[open]"))`, "045 111 222");
      must(await clickAt(`${BUTTON}("Ruaj", document.querySelector("dialog[open]"))`), "no save button");
      await until(`!document.querySelector("dialog[open]")`, "the dialog to close");
      const found = await api(`/api/patients?q=${encodeURIComponent(`${patient.name} Lokal`)}`);
      must(found.status === 200 && found.body.patients.length === 1, `the patient is not on the server (${found.body?.patients?.length} found)`);
      await until(`document.querySelector("main").innerText.includes(${JSON.stringify(`${patient.name} Lokal`)})`, "the new patient in the list on screen");
      return `phone stored as ${found.body.patients[0].phone}`;
    });

    await flow("staff correct a visit report; the earlier version is kept", async () => {
      await go("/app/kalendari");
      for (let i = 0; i < 25; i++) {
        if (await evaluate(`[...document.querySelectorAll("main ul li button")].some((b) => b.innerText.includes("Raport"))`)) break;
        await clickAt(`document.querySelector('button[aria-label="Dita e kaluar"]')`);
        await settle(250);
      }
      must(await clickAt(`[...document.querySelectorAll("main ul li button")].find((b) => b.innerText.includes("Raport"))`), "no past appointment with a report in the demo data");
      await until(`Boolean(${BY_LABEL}("Çfarë u punua", document.querySelector("dialog[open]")))`, "the report form");
      const before = Number((await evaluate(`document.querySelector("dialog[open]").innerText.match(/Versioni (\\d+)/)?.[1] ?? "0"`)) || 0);
      const text = `Korrigjim nga prova e rrjedhës ${stamp}.`;
      await evaluate(`${BY_LABEL}("Çfarë u punua", document.querySelector("dialog[open]")).select()`);
      await cdp.send("Input.insertText", { text });
      must(await clickAt(`${BUTTON}("Ruaj ndryshimet", document.querySelector("dialog[open]"))`), "no save button for the report");
      await until(`document.querySelector("dialog[open]").innerText.includes("Versioni ${before + 1}")`, `version ${before + 1}`);
      const shown = await evaluate(`document.querySelector("dialog[open]").innerText`);
      must(shown.includes("Versionet e mëparshme"), "the earlier version is not offered");
      must((await evaluate(`${BY_LABEL}("Çfarë u punua", document.querySelector("dialog[open]")).value`)) === text, "the form does not show the saved text");
      // And on the server: the new text is the current report, one version further, the old text is kept.
      must(lastAppointmentId > 0, "could not tell which appointment the dialog was showing");
      const saved = await api(`/api/appointments/${lastAppointmentId}`);
      must(saved.status === 200, `the appointment is not readable on the server (status ${saved.status})`);
      must(saved.body.report.workDone === text && saved.body.report.version === before + 1, `the server holds version ${saved.body.report?.version} with another text`);
      must(saved.body.versions.length === before + 1 && saved.body.versions.some((v) => v.version === before && v.workDone !== text), "the server did not keep the earlier version");
      await key("Escape", "Escape", 27);
      return `appointment ${lastAppointmentId}: version ${before} -> ${before + 1}, earlier text kept on the server`;
    });

    // The patient the next flow books at the desk; the cancellation flow after it cancels that appointment,
    // because this patient has an email address and so exercises the "email only stored" outcome.
    const local = { name: `Pacient Lokal ${stamp}`, phone: "049 700 1" + stamp.slice(-2), email: `lokal-${stamp}@example.test`, booked: false };

    await flow("staff book a patient at the desk through the dialog", async () => {
      await go("/app/kalendari");
      must((await openBusyDay(1)) >= 1, "no working day with appointments found to book on");
      const day = await evaluate(`document.querySelector('main input[type="date"]').value`);
      must(await clickAt(`${BUTTON}("Termin i ri", document.querySelector("main"))`), "no 'new appointment' button");
      await until(`[...(document.querySelector("dialog[open]")?.querySelectorAll("button[aria-pressed]") ?? [])].some((b) => /^\\d{2}:\\d{2}$/.test(b.innerText.trim()))`, "free times in the booking dialog");
      // The last free time of the day, to stay clear of what the other flows touch.
      const SLOTS = `[...document.querySelector("dialog[open]").querySelectorAll("button[aria-pressed]")].filter((b) => /^\\d{2}:\\d{2}$/.test(b.innerText.trim()))`;
      const time = await evaluate(`${SLOTS}.at(-1).innerText.trim()`);
      await clickAt(`${SLOTS}.at(-1)`);
      must((await evaluate(`${SLOTS}.at(-1).getAttribute("aria-pressed")`)) === "true", "the chosen time is not marked as chosen");
      // Nothing can be booked without a patient: the button stays off until a name is there.
      must(await evaluate(`[...document.querySelector("dialog[open]").querySelectorAll("button")].find((b) => b.innerText.includes("Cakto terminin")).disabled`), "the booking button was enabled without a patient");
      await typeInto(`${BY_LABEL}("Emri dhe mbiemri", document.querySelector("dialog[open]"))`, local.name);
      await typeInto(`${BY_LABEL}("Telefoni", document.querySelector("dialog[open]"))`, local.phone);
      await typeInto(`${BY_LABEL}("Email", document.querySelector("dialog[open]"))`, local.email);
      must(await clickAt(`${BUTTON}("Cakto terminin", document.querySelector("dialog[open]"))`), "the booking button stayed off with a patient and a time");
      await until(`!document.querySelector("dialog[open]")`, "the booking dialog to close");
      await until(`[...document.querySelectorAll("main ul li button")].some((b) => b.innerText.includes(${JSON.stringify(local.name)}))`, "the new appointment in the day's list");
      const row = await evaluate(`[...document.querySelectorAll("main ul li button")].find((b) => b.innerText.includes(${JSON.stringify(local.name)})).innerText.replace(/\\s+/g, " ")`);
      must(row.startsWith(time) && row.includes("I caktuar"), `the list shows "${row}", not ${time} and booked`);
      // On the server: one new patient, added by the clinic, with one booked appointment at that time on that
      // day, and a confirmation that was only stored (no mail server in this run).
      const found = await api(`/api/patients?q=${encodeURIComponent(local.name)}`);
      must(found.status === 200 && found.body.patients.length === 1, `the patient is not on the server (${found.body?.patients?.length} found)`);
      const record = await api(`/api/patients/${found.body.patients[0].id}`);
      const visit = record.body.visits[0];
      must(record.body.patient.source === "local" && record.body.visits.length === 1, "the server does not hold exactly one visit for a patient added by the clinic");
      const shownAt = await evaluate(`new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(${JSON.stringify(visit.startsAt)}))`);
      must(visit.status === "booked" && visit.source === "local" && shownAt === `${day}, ${time}`, `the server holds ${visit.status} at ${shownAt}, not booked at ${day}, ${time}`);
      must(visit.lastEmailStatus === "stored", `the confirmation is recorded as "${visit.lastEmailStatus}", not stored`);
      local.booked = true;
      return `${local.name}, ${day} ${time}; on the server as booked, confirmation stored`;
    });

    await flow("staff cancel an appointment and are told what happened to the email", async () => {
      await go("/app/kalendari");
      for (let i = 0; i < 8; i++) {
        if (await evaluate(`[...document.querySelectorAll("main ul li button")].some((b) => b.innerText.includes("I caktuar"))`)) break;
        await clickAt(`document.querySelector('button[aria-label="Dita tjetër"]')`);
        await settle(250);
      }
      // The appointment booked at the desk just now, when there is one: its patient has an email address.
      const PICK = `([...document.querySelectorAll("main ul li button")].find((b) => b.innerText.includes("I caktuar") && b.innerText.includes(${JSON.stringify(local.booked ? local.name : "")})))`;
      const who = await evaluate(`${PICK}?.querySelector("span.min-w-0 span")?.innerText.trim() ?? ""`);
      must(who, "no upcoming booked appointment in the demo data");
      must(!local.booked || who === local.name, "the appointment booked at the desk is not on the day the calendar opened on");
      await clickAt(PICK);
      await until(`Boolean(${BUTTON}("Anulo terminin", document.querySelector("dialog[open]")))`, "the appointment dialog");
      await clickAt(`${BUTTON}("Anulo terminin", document.querySelector("dialog[open]"))`);
      await until(`Boolean(${BY_LABEL}("Arsyeja", document.querySelector("dialog[open]")))`, "the reason field");
      await typeInto(`${BY_LABEL}("Arsyeja", document.querySelector("dialog[open]"))`, "Provë e rrjedhës");
      await clickAt(`${BUTTON}("Anulo dhe njofto pacientin", document.querySelector("dialog[open]"))`);
      await sleep(600);
      // Less than the promised notice away: the app asks once more, and says so.
      if (await evaluate(`Boolean(${BUTTON}("Anuloje gjithsesi", document.querySelector("dialog[open]")))`)) {
        await clickAt(`${BUTTON}("Anuloje gjithsesi", document.querySelector("dialog[open]"))`);
      }
      await until(`document.querySelector("dialog[open]").innerText.includes("Termini u anulua")`, "the cancellation result");
      const told = await evaluate(`document.querySelector("dialog[open]").innerText`);
      // No mail server in this run: the screen must say the patient was NOT told, never that they were.
      must(told.includes("NUK u njoftua me email"), "the result does not say that the patient was not emailed");
      must(!told.includes("Pacienti u njoftua me email"), "the result claims the patient was emailed");
      // And on the server: cancelled by the clinic, with the reason, and an email that was only stored.
      must(lastAppointmentId > 0, "could not tell which appointment the dialog was showing");
      const after = await api(`/api/appointments/${lastAppointmentId}`);
      must(after.status === 200, `the appointment is not readable on the server (status ${after.status})`);
      const a = after.body.appointment;
      must(a.status === "cancelled" && a.cancelledBy === "clinic" && a.cancelReason === "Provë e rrjedhës", `the server holds status ${a.status}, cancelled by ${a.cancelledBy}, reason "${a.cancelReason}"`);
      must(a.patientEmail ? a.lastEmailStatus === "stored" : a.lastEmailStatus === null, `the server records the email as "${a.lastEmailStatus}", not as stored`);
      // After the desk booking this must be the branch with an address: the email exists and was only stored.
      must(!local.booked || (a.patientEmail === local.email && a.lastEmailStatus === "stored"), "the cancelled appointment is not the one with an email address, so the stored branch was not exercised");
      await key("Escape", "Escape", 27);
      await settle(300);
      must(await evaluate(`[...document.querySelectorAll("main ul li button")].some((b) => b.innerText.includes(${JSON.stringify(who)}) && b.innerText.includes("I anuluar"))`), "the calendar does not show the appointment as cancelled");
      return `${who} (appointment ${lastAppointmentId}): cancelled on the server with the reason, email ${a.lastEmailStatus ?? "none (no address)"}; screen says the patient was not emailed`;
    });
    const failures = report.flows.filter((f) => !f.ok).length;
    console.log(`flows: ${report.flows.length - failures} of ${report.flows.length} passed`);
  }

  // ---- 4. first-load performance ---------------------------------------------------------------------
  const PROFILES = {
    "desktop-unthrottled": { vp: "desktop", net: null, cpu: 1 },
    // Lighthouse's mobile profile: slow 4G (1.6 Mbit/s down, 750 kbit/s up, 150 ms round trip), CPU 4x slower.
    "mobile-slow4g-cpu4x": { vp: "mobile", net: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }, cpu: 4 },
  };
  // Each page is loaded cold PERF_RUNS times; every run is kept, and the summary line shows the median,
  // because a single load on a busy machine says little.
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const [profileName, prof] of SECTIONS.has("perf") ? Object.entries(PROFILES) : []) {
    for (const [name, p, account] of [["booking", "/rezervo", null], ["login", "/kycu", null], ["kalendari", "/app/kalendari", ADMIN]]) {
     const runs = [];
     for (let run = 0; run < PERF_RUNS; run++) {
      await viewport(prof.vp);
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      if (account) await login(account);
      else await cdp.send("Network.clearBrowserCookies");
      await cdp.send("Page.navigate", { url: "about:blank" });
      await cdp.send("Network.clearBrowserCache");
      if (prof.net) await cdp.send("Network.emulateNetworkConditions", prof.net);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
      requests = new Map();
      await cdp.send("Page.navigate", { url: BASE + p });
      await settle(1500);
      const timing = await evaluate(`new Promise((resolve) => {
        const nav = performance.getEntriesByType("navigation")[0];
        const fcp = performance.getEntriesByName("first-contentful-paint")[0];
        let lcp = 0;
        try { new PerformanceObserver((list) => { for (const e of list.getEntries()) lcp = Math.max(lcp, e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
        setTimeout(() => resolve({ ttfb: Math.round(nav.responseStart), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null, lcp: Math.round(lcp) || null }), 300);
      })`);
      const list = [...requests.values()];
      const sum = (f) => list.filter(f).reduce((n, r) => n + r.bytes, 0);
      runs.push(timing);
      if (run < PERF_RUNS - 1) continue;
      report.performance.push({
        profile: profileName,
        page: name,
        ...timing,
        runs,
        median: { fcp: median(runs.map((r) => r.fcp ?? 0)), lcp: median(runs.map((r) => r.lcp ?? 0)), domContentLoaded: median(runs.map((r) => r.domContentLoaded)) },
        requests: list.length,
        transferredBytes: sum(() => true),
        scriptBytes: sum((r) => r.type === "Script"),
        cssBytes: sum((r) => r.type === "Stylesheet"),
        fontBytes: sum((r) => r.type === "Font"),
        thirdPartyRequests: list.filter((r) => !r.url.startsWith(BASE)).map((r) => new URL(r.url).host).filter((h, i, a) => a.indexOf(h) === i),
        ownAssets: list.filter((r) => r.url.startsWith(BASE) && (r.type === "Script" || r.type === "Stylesheet" || r.type === "Document" || r.type === "Font")).map((r) => ({ url: r.url.replace(BASE, ""), type: r.type, bytes: r.bytes, encoding: r.encoding, cache: r.cache })),
        // Code that only the clinic's side needs. On a patient's page this list should be empty.
        staffCode: list.filter((r) => r.type === "Script" && /\/(staff|AppLayout|Calendar|Reports|Patients|Due|Outbox|Settings|AppointmentDialog|BookLocalDialog)-/.test(r.url)).map((r) => r.url.replace(BASE, "")),
      });
      console.log(`perf ${profileName.padEnd(20)} ${name.padEnd(10)} median of ${PERF_RUNS}: FCP ${median(runs.map((r) => r.fcp ?? 0))} ms  LCP ${median(runs.map((r) => r.lcp ?? 0))} ms  ${list.length} requests  ${Math.round(sum(() => true) / 1024)} kB`);
     }
    }
  }
} catch (err) {
  failed = true;
  report.notes.push(`audit stopped early: ${err instanceof Error ? err.stack : String(err)}`);
  console.error(err);
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(OUT, process.env.REPORT_NAME || (SECTIONS.size === 3 && !process.env.ONLY_VIEWPORT ? "report.json" : `report.${[...SECTIONS].join("-")}${process.env.ONLY_VIEWPORT ? "-" + process.env.ONLY_VIEWPORT : ""}.json`)), JSON.stringify(report, null, 2));
  console.log(`\n${report.browser} (${exe})\nreport: ${path.join(OUT, "report.json")}`);
  proc.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold a file; the temp folder is harmless */
  }
  // A failed flow, or a run that could not finish, is a failed run: scripts and people can rely on the status.
  process.exit(failed ? 1 : 0);
}
