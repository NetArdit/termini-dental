import type { Ctx } from "./context";
import { safeError, silentLogger } from "./log";
import { attemptDelivery, queueEmail, retryPendingEmails } from "./mail";
import { composeReminder } from "./notify";
import { HOUR_MS } from "./time";

/**
 * Sends the "your appointment is tomorrow" email once per appointment, for appointments that start within
 * the next 24 hours. Returns how many appointments were dealt with.
 *
 * "This appointment has had its reminder" and "this reminder must be sent" are written in one transaction.
 * So a reminder is never sent twice (the mark is taken first, by one process only), and never lost either:
 * if the process dies before the send, or the mail server refuses, the message is still in the log and
 * retryPendingEmails picks it up.
 */
export async function sendDueReminders(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const due = await ctx.db.query<{ id: number }>(
    `SELECT id FROM appointments
      WHERE status = 'booked' AND reminder_sent_at IS NULL AND starts_at > $1 AND starts_at <= $2
      ORDER BY starts_at`,
    [now, new Date(now.getTime() + 24 * HOUR_MS)],
  );
  let handled = 0;
  for (const row of due) {
    const email = await composeReminder(ctx, row.id);
    const queued = await ctx.db.tx(async (q) => {
      const marked = await q.query("UPDATE appointments SET reminder_sent_at = $2 WHERE id = $1 AND status = 'booked' AND reminder_sent_at IS NULL RETURNING id", [row.id, now]);
      // Another process got there first, or the appointment was cancelled a moment ago.
      if (!marked.length) return undefined;
      // A patient without an address gets no reminder; the mark keeps us from asking again every ten minutes.
      return email ? await queueEmail(q, email) : null;
    });
    if (queued === undefined) continue;
    handled += 1;
    if (queued !== null && ctx.mailer) await attemptDelivery(ctx.db, ctx.mailer, queued, now);
  }
  return handled;
}

/**
 * Everything that has to happen now and then whether or not anybody is using the site: reminders, mail
 * that did not go out the first time, counters nobody will ask about again. One part failing does not stop
 * the others. Returns what was done, in numbers; `failed` names the parts that did not run.
 */
export async function runHousekeeping(ctx: Ctx): Promise<{ reminders: number; emailRetries: number; failed: string[] }> {
  const log = ctx.log ?? silentLogger;
  const failed: string[] = [];
  const part = async (name: string, run: () => Promise<number>) => {
    try {
      return await run();
    } catch (err) {
      failed.push(name);
      log.error(`${name}_failed`, safeError(err));
      return 0;
    }
  };
  // Counts only: which patient a reminder went to is in the outbox, not in the log.
  const reminders = await part("reminders", () => sendDueReminders(ctx));
  if (reminders) log.info("reminders", { handled: reminders });
  const emailRetries = await part("email_retries", () => retryPendingEmails(ctx.db, ctx.mailer, ctx.now()));
  if (emailRetries) log.info("email_retries", { attempts: emailRetries });
  // Counters of parties that never came back.
  await part("limiter_prune", async () => (await ctx.limiter?.prune(ctx.now()), 0));
  return { reminders, emailRetries, failed };
}

export function startReminderLoop(ctx: Ctx, everyMs = 10 * 60 * 1000) {
  const timer = setInterval(() => void runHousekeeping(ctx), everyMs);
  timer.unref();
  void runHousekeeping(ctx);
  return timer;
}
