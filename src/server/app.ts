import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import { attachUser } from "./auth";
import type { Ctx } from "./context";
import { schemaVersion } from "./db";
import { HttpError, errorHandler } from "./errors";
import { MemoryRateLimiter } from "./limits";
import { requestLog, safeError, silentLogger } from "./log";
import { authRoutes } from "./routes/auth";
import { clinicRoutes } from "./routes/clinic";
import { galleryRoutes } from "./routes/gallery";
import { publicRoutes } from "./routes/public";
import { staffRoutes } from "./routes/staff";

export function createApp(ctx: Ctx): Express {
  const app = express();
  app.disable("x-powered-by");
  const log = ctx.log ?? silentLogger;
  ctx.limiter ??= new MemoryRateLimiter();
  // Behind a hosting proxy the client address is in X-Forwarded-For; trust it only when told to.
  if (ctx.trustProxy) app.set("trust proxy", 1);
  app.use(requestLog(log));

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  // Text answers (the script, the styles, JSON) travel compressed when the browser can take it.
  app.use(compression());
  // One address takes more than the rest: a picture of a visit, sent as text inside JSON. It is named here,
  // before the general limit, so that nothing else can be made to swallow megabytes.
  app.post("/api/appointments/:id/images", express.json({ limit: "4mb" }));
  // And a work for the gallery: up to two pictures.
  app.post("/api/gallery", express.json({ limit: "4mb" }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Cross-site request forgery: the session cookie is SameSite=Lax, and in addition every request that
  // changes something must carry a header that a form on another site cannot set.
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("x-requested-with") !== "termini") {
      throw new HttpError(400, "Kërkesë e pavlefshme.");
    }
    // Patient data must never sit in a shared cache.
    _res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Only the API needs to know who is asking; a script or a font is not worth a session lookup.
  app.use("/api", attachUser(ctx.db, ctx.now));
  // For the host's health check and for a person asking "is it up, and on which schema?". Says nothing
  // about any clinic. 503 when the database does not answer, so a host can restart or hold traffic.
  app.get("/api/health", async (_req, res) => {
    try {
      res.json({ ok: true, schemaVersion: await schemaVersion(ctx.db), mail: ctx.mailer ? "configured" : "not configured" });
    } catch (err) {
      log.error("health_check_failed", safeError(err));
      res.status(503).json({ ok: false });
    }
  });
  app.use("/api/auth", authRoutes(ctx));
  app.use("/api", galleryRoutes(ctx));
  app.use("/api/public", publicRoutes(ctx));
  app.use("/api", clinicRoutes(ctx));
  app.use("/api", staffRoutes(ctx));
  app.use("/api", () => {
    throw new HttpError(404, "Nuk u gjet.");
  });

  // The built web app, when it exists (production). Any other path is the single-page app.
  const webDir = ctx.webDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/web");
  if (existsSync(path.join(webDir, "index.html"))) {
    // The build names every file in /assets after its content, so a name never changes meaning: browsers
    // may keep them for a year. A name that is not there is a 404, never the page (an old tab asking for a
    // script of the previous release must not get HTML back).
    app.use("/assets", express.static(path.join(webDir, "assets"), { immutable: true, maxAge: "365d", index: false }), (_req, res) => {
      res.status(404).type("text/plain").send("Not found");
    });
    // The rest (icon, licences) keeps its name between releases: an hour, then ask again.
    app.use(express.static(webDir, { index: false, maxAge: "1h" }));
    // The page itself is the pointer to the current assets, so it is always checked with the server.
    app.get(/.*/, (_req, res) => res.sendFile(path.join(webDir, "index.html"), { cacheControl: false, headers: { "Cache-Control": "no-cache" } }));
  }

  app.use(errorHandler(log));
  return app;
}
