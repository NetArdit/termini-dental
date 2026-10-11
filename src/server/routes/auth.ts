import { Router } from "express";
import { z } from "zod";
import { SESSION_COOKIE, createSession, hashPassword, hashToken, requireUser, setSessionCookie, verifyPassword } from "../auth";
import { addressOf, clinicById, mapClinic, type Ctx } from "../context";
import { UNIQUE_VIOLATION, pgErrorCode, type Queryer } from "../db";
import { HttpError, parse } from "../errors";

const email = z.string().trim().toLowerCase().email("Email i pavlefshëm.").max(200);
const password = z.string().min(8, "Fjalëkalimi duhet të ketë të paktën 8 shkronja.").max(200);
const name = (label: string) => z.string().trim().min(2, `${label} është i detyrueshëm.`).max(120);

const signupSchema = z.object({
  clinicName: name("Emri i klinikës"),
  fullName: name("Emri juaj"),
  email,
  password,
  /** The person signing up also treats patients (the usual case in a small clinic). */
  isDentist: z.boolean().default(true),
});

const loginSchema = z.object({ email, password: z.string().min(1).max(200) });

/** "Klinika Dentare Dr. Arta" -> "klinika-dentare-dr-arta" */
export function slugify(text: string): string {
  const base = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "klinika";
}

async function freeSlug(q: Queryer, wanted: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? wanted : `${wanted}-${i + 1}`;
    const taken = await q.query("SELECT 1 FROM clinics WHERE slug = $1", [candidate]);
    if (!taken.length) return candidate;
  }
  throw new HttpError(409, "Ky emër klinike është i zënë. Provoni një emër tjetër.");
}

/** Monday to Friday, 09:00 to 17:00: a sensible start a clinic then edits. */
export async function insertDefaultHours(q: Queryer, userId: number) {
  for (let weekday = 1; weekday <= 5; weekday++) {
    await q.query("INSERT INTO working_hours (user_id, weekday, start_minute, end_minute) VALUES ($1, $2, $3, $4)", [userId, weekday, 9 * 60, 17 * 60]);
  }
}

const DEFAULT_SERVICES: Array<[string, number]> = [
  ["Kontroll", 30],
  ["Mbushje", 45],
  ["Pastrim i gurëzave", 45],
  ["Nxjerrje dhëmbi", 30],
];

const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;

export function authRoutes(ctx: Ctx): Router {
  const r = Router();
  // Password guessing is stopped by counting attempts per email and client address (see limits.ts).
  const limiter = ctx.limiter!;

  // Creates a clinic and its first administrator. A staff account belongs to exactly one clinic.
  r.post("/signup", async (req, res) => {
    const input = parse(signupSchema, req.body);
    const passwordHash = await hashPassword(input.password);
    let created: { userId: number; clinicId: number };
    try {
      created = await ctx.db.tx(async (q) => {
        const slug = await freeSlug(q, slugify(input.clinicName));
        const clinic = await q.query<{ id: number }>("INSERT INTO clinics (slug, name) VALUES ($1, $2) RETURNING id", [slug, input.clinicName]);
        const clinicId = clinic[0]!.id;
        const user = await q.query<{ id: number }>(
          "INSERT INTO users (clinic_id, role, full_name, email, password_hash, is_bookable) VALUES ($1, 'admin', $2, $3, $4, $5) RETURNING id",
          [clinicId, input.fullName, input.email, passwordHash, input.isDentist],
        );
        const userId = user[0]!.id;
        if (input.isDentist) await insertDefaultHours(q, userId);
        for (const [serviceName, minutes] of DEFAULT_SERVICES) {
          await q.query("INSERT INTO services (clinic_id, name, duration_minutes) VALUES ($1, $2, $3)", [clinicId, serviceName, minutes]);
        }
        return { userId, clinicId };
      });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) throw new HttpError(409, "Ky email është i regjistruar tashmë.", { email: "I zënë" });
      throw err;
    }
    const session = await createSession(ctx.db, created.userId, ctx.now());
    setSessionCookie(res, session.token, session.expires);
    res.status(201).json({ ok: true });
  });

  r.post("/login", async (req, res) => {
    const input = parse(loginSchema, req.body);
    const key = `${input.email}|${addressOf(ctx, req)}`;
    // The attempt is counted BEFORE the password is looked at, in one step with the check. Counting only
    // after a failure would let a burst of guesses sent together all pass the check before any is counted.
    // A successful login wipes the count, so only failures add up.
    if (!(await limiter.attempt("login", key, MAX_FAILURES, WINDOW_MS, ctx.now()))) {
      throw new HttpError(429, "Shumë përpjekje të dështuara. Provoni përsëri pas 15 minutash.");
    }

    const rows = await ctx.db.query<{ id: number; password_hash: string; is_active: boolean }>(
      "SELECT id, password_hash, is_active FROM users WHERE email = $1",
      [input.email],
    );
    const user = rows[0];
    // One message for "no such account", "wrong password" and "deactivated": nothing to learn from the reply.
    const ok = user ? (await verifyPassword(input.password, user.password_hash)) && user.is_active : false;
    if (!user || !ok) throw new HttpError(401, "Email ose fjalëkalim i gabuar.");
    await limiter.forgive("login", key);
    const session = await createSession(ctx.db, user.id, ctx.now());
    setSessionCookie(res, session.token, session.expires);
    res.json({ ok: true });
  });

  r.post("/logout", async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token) await ctx.db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  r.get("/me", async (req, res) => {
    const user = requireUser(req);
    res.json({ user, clinic: mapClinic(await clinicById(ctx.db, user.clinicId)) });
  });

  return r;
}
