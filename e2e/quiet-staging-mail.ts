import { openPostgres } from "../src/server/db";

// Run BEFORE a staging site with demo data is given a real mail server. The demo patients and the browser
// flows use addresses under example.test, which do not exist: every message to them bounces, and a mail
// provider suspends a new account that bounces. This takes those addresses off the patients (so no reminder
// is written for them) and retires the messages already waiting for them (so no retry sends them).
//   DATABASE_URL=<the staging database> npx tsx e2e/quiet-staging-mail.ts
// Reads no .env file on purpose: the database must be named on the command line, never picked up by accident.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the staging database.");
  process.exit(1);
}
const db = await openPostgres(url, { migrate: false, maxConnections: 1 });
const done = await db.tx(async (q) => {
  const patients = await q.query("UPDATE patients SET email = NULL WHERE email LIKE '%.test' RETURNING id");
  // Three attempts is where the system stops retrying by itself (mail.ts).
  const messages = await q.query("UPDATE email_log SET attempts = 3, status = 'failed' WHERE to_email LIKE '%.test' AND status <> 'accepted' RETURNING id");
  const waiting = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM email_log WHERE status IN ('stored', 'failed') AND attempts < 3");
  return { patients: patients.length, messages: messages.length, stillWaiting: waiting[0]!.n };
});
await db.close();
console.log(`addresses removed from ${done.patients} demo patients; ${done.messages} waiting messages retired; ${done.stillWaiting} real message(s) still waiting to be sent.`);
