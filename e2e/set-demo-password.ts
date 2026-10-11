import { hashPassword } from "../src/server/auth";
import { openPostgres } from "../src/server/db";

// Gives the two demo accounts of a hosted demo clinic the password in DEMO_PASSWORD and logs everybody out.
// For a staging site that is reachable from outside: the default demo password is printed in the README.
//   DATABASE_URL=<the staging database> DEMO_PASSWORD=<at least 12 characters> npx tsx e2e/set-demo-password.ts
// Reads no .env file on purpose: the database must be named on the command line, never picked up by accident.

const url = process.env.DATABASE_URL;
const password = process.env.DEMO_PASSWORD ?? "";
if (!url || password.length < 12) {
  console.error("Set DATABASE_URL (the staging database) and DEMO_PASSWORD (at least 12 characters).");
  process.exit(1);
}
const db = await openPostgres(url, { migrate: false, maxConnections: 1 });
const changed = await db.tx(async (q) => {
  const users = await q.query<{ id: number }>("UPDATE users SET password_hash = $1 WHERE email IN ('arta@demo.test', 'besnik@demo.test') RETURNING id", [await hashPassword(password)]);
  await q.query("DELETE FROM sessions WHERE user_id = ANY($1::int[])", [users.map((u) => u.id)]);
  return users.length;
});
await db.close();
console.log(`${changed} demo accounts now use the new password; their sessions are ended.`);
