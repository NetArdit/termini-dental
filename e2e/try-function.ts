// Runs the scheduled function's handler on this machine, with the environment given on the command line,
// and says how it ended without printing an error's text (it can quote a connection string).
//   DATABASE_URL=<staging> NODE_ENV=production PUBLIC_URL=https://... npx tsx e2e/try-function.ts
import { serverlessContext } from "../src/server/serverless";
import { handler } from "../netlify/functions/housekeeping";

try {
  const ctx = await serverlessContext();
  console.log("context opened; schema rows:", (await ctx.db.query("SELECT count(*)::int AS n FROM schema_migrations"))[0]);
  console.log("handler:", await handler());
  await ctx.db.close();
} catch (err) {
  const e = err as { constructor: { name: string }; code?: unknown; problems?: unknown };
  console.log("failed:", e.constructor.name, "code:", e.code ?? "-", "config problems:", e.problems ?? "-");
  process.exit(1);
}
