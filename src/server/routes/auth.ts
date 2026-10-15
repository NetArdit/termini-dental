import { Router } from "express";
import { z } from "zod";
import { SESSION_COOKIE, createSession, hashPassword, hashToken, newToken, requireUser, setSessionCookie, verifyPassword } from "../auth";
import { addressOf, audit, clinicById, mapClinic, type Ctx } from "../context";
import { pgErrorCode } from "../db";
import { HttpError, parse } from "../errors";

const email = z.string().trim().toLowerCase().email("Email i pavlefshëm.").max(200);

const loginSchema = z.object({ email, password: z.string().min(1).max(200) });

const HOUR_MS = 60 * 60 * 1000;
/** How long a link for a new password works. */
const RESET_LINK_MS = 30 * 60 * 1000;
const RESET_ASKS_PER_EMAIL = 3;
const RESET_ASKS_PER_ADDRESS = 10;
const RESET_USES_PER_ADDRESS = 10;
/** Every request for a link is answered this long after it arrived (see the route). */
const RESET_ANSWER_MS = 5_000;
/** Kept back from that time for writing down what happened to the mail. */
const RESET_BOOKKEEPING_MS = 400;
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;

export function authRoutes(ctx: Ctx): Router {
  const r = Router();
  // Password guessing is stopped by counting attempts per email and client address (see limits.ts).
  const limiter = ctx.limiter!;

  // There is no sign-up. The clinic and its first administrator are made from the command line
  // (bootstrap.ts); further staff are added by an administrator who is signed in.

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

  // ---- a forgotten password ----------------------------------------------------------------------------
  //
  // Asking: the answer is the same whether the address belongs to an account or not, so nothing can be
  // learned about who works here. An active account gets a link that works once, for half an hour; asking
  // again ends the earlier links. Only the hash of the link's secret is stored, and the mail is handed to
  // the mail server without being written down anywhere.
  r.post("/forgot", async (req, res) => {
    const input = parse(z.object({ email }), req.body);
    const now = ctx.now();
    const address = addressOf(ctx, req);
    // Without a mail server nobody can be sent a link, whoever they are: saying so reveals nothing about
    // any account, and is better than a promise that cannot be kept.
    if (!ctx.mailer) {
      throw new HttpError(503, "Rivendosja me email nuk është e mundur tani. Kërkojini administratorit të klinikës t'jua ndryshojë fjalëkalimin.");
    }
    // Counted per address asked about and per sender, known or not: an inbox must not be flooded.
    const within = (await limiter.attempt("reset", `ask|${input.email}`, RESET_ASKS_PER_EMAIL, HOUR_MS, now)) && (await limiter.attempt("reset", `from|${address}`, RESET_ASKS_PER_ADDRESS, HOUR_MS, now));
    if (!within) throw new HttpError(429, "Shumë kërkesa. Provoni përsëri pas një ore.");

    // Every answer leaves at the same moment after the request came in, whether there was an account and a
    // mail to hand over or nothing to do at all: how long the answer took says nothing about the address.
    const answerAt = Date.now() + (ctx.resetAnswerMs ?? RESET_ANSWER_MS);
    const untilAnswer = () => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, answerAt - Date.now())));

    // What there is to do for an address that has an account runs beside the clock, never in front of it:
    // if the database or the mail server is slow, the answer still leaves at its moment and the work goes on
    // behind it. So a slow day cannot make a known address answer later than an unknown one.
    const mailer = ctx.mailer;
    let step: "lookup" | "issue" | "mail" | "record" = "lookup";
    const work = (async () => {
      const user = (await ctx.db.query<{ id: number; clinic_id: number; full_name: string; clinic_name: string }>(
        "SELECT u.id, u.clinic_id, u.full_name, c.name AS clinic_name FROM users u JOIN clinics c ON c.id = u.clinic_id WHERE u.email = $1 AND u.is_active",
        [input.email],
      ))[0];
      if (user) {
        const token = newToken();
        step = "issue";
        await ctx.db.tx(async (q) => {
          // One request at a time per person: of two sent together, the second ends the first one's link, so
          // there is never more than one open.
          await q.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [user.id]);
          await q.query("UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [user.id, now]);
          await q.query("INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)", [user.id, hashToken(token), now, new Date(now.getTime() + RESET_LINK_MS)]);
        });
        // After "#": a browser keeps that part to itself, so the secret reaches no server's request log.
        const link = `${ctx.publicUrl}/fjalekalimi#${token}`;
        // Three outcomes, and they are not the same thing:
        //   "sent": the mail server took the message.
        //   "refused": it said no, or could not be reached. Nobody will get this link, so it is ended.
        //   "unknown": no answer by the time this request must answer. The message may still go out, so the
        //     link stays good: ending it would leave the person holding a mail whose link is already dead.
        let outcome: "sent" | "refused" | "unknown" = "unknown";
        step = "mail";
        const sending = mailer
          .send({
            to: input.email,
            subject: `Fjalëkalim i ri për llogarinë tuaj në ${user.clinic_name}`,
            text: [
              `Përshëndetje ${user.full_name},`,
              "",
              `Dikush kërkoi një fjalëkalim të ri për llogarinë tuaj në ${user.clinic_name}. Nëse ishit ju, hapeni këtë link brenda 30 minutave dhe vendosni fjalëkalimin e ri:`,
              link,
              "",
              "Linku punon vetëm një herë. Nëse nuk e kërkuat ju, mos bëni asgjë: fjalëkalimi juaj mbetet ai që është.",
            ].join("\n"),
          })
          .then(
            () => {
              outcome = "sent";
            },
            () => {
              outcome = "refused";
            },
          );
        // A little before the answer is due, so that what is known by then can still be written down.
        await Promise.race([sending, new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, answerAt - Date.now() - RESET_BOOKKEEPING_MS)))]);
        const known = outcome as "sent" | "refused" | "unknown";
        step = "record";
        if (known === "refused") await ctx.db.query("UPDATE password_resets SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL", [hashToken(token), now]);
        // On record for the administrator, without the link: who was asked about, and what became of the mail.
        await audit(ctx.db, { clinicId: user.clinic_id, userId: null, action: "password_reset_requested", entity: "user", entityId: user.id, meta: { delivery: known } });
      }
    })().catch((err: unknown) => {
      // Not the person's to see, and nothing of the link: only that it happened.
      // What an operator needs to find the cause: the kind of error, the database's own code when it has
      // one, and at which step it happened. Never the message (it can quote an address or a connection).
      ctx.log?.error("password_reset_request_failed", { error: err instanceof Error ? err.name : "unknown", code: pgErrorCode(err) ?? null, step });
    });
    await Promise.race([work, untilAnswer()]);
    await untilAnswer();
    // The same words for everybody. They promise nothing that may not have happened.
    res.json({ ok: true });
  });

  // Using the link: once, within its half hour, for an account that is still active.
  r.post("/reset", async (req, res) => {
    const input = parse(z.object({ token: z.string().min(20).max(200), password: z.string().min(8, "Fjalëkalimi duhet të ketë të paktën 8 shkronja.").max(200) }), req.body);
    const now = ctx.now();
    if (!(await limiter.attempt("reset", `use|${addressOf(ctx, req)}`, RESET_USES_PER_ADDRESS, WINDOW_MS, now))) {
      throw new HttpError(429, "Shumë përpjekje. Provoni përsëri pas 15 minutash.");
    }
    const passwordHash = await hashPassword(input.password);
    const done = await ctx.db.tx(async (q) => {
      const rows = await q.query<{ id: number; user_id: number; clinic_id: number; email: string }>(
        `SELECT r.id, r.user_id, u.clinic_id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
          WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > $2 AND u.is_active FOR UPDATE OF r`,
        [hashToken(input.token), now],
      );
      const row = rows[0];
      if (!row) return null;
      await q.query("UPDATE users SET password_hash = $2 WHERE id = $1", [row.user_id, passwordHash]);
      // This link and any other still open for the same person end here, and so does every open session:
      // whoever was signed in with the old password is out.
      await q.query("UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [row.user_id, now]);
      await q.query("DELETE FROM sessions WHERE user_id = $1", [row.user_id]);
      await audit(q, { clinicId: row.clinic_id, userId: row.user_id, action: "password_reset_completed", entity: "user", entityId: row.user_id });
      return row;
    });
    // One answer for a link that never existed, was used, has expired or belongs to a closed account.
    if (!done) throw new HttpError(400, "Ky link nuk është më i vlefshëm. Kërkoni një link të ri.");
    // The failed sign-ins that led here no longer count against the person.
    await limiter.forgive("login", `${done.email}|${addressOf(ctx, req)}`);
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
