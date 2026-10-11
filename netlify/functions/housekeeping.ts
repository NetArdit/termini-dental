import { runHousekeeping } from "../../src/server/reminders";
import { serverlessContext, startFailure } from "../../src/server/serverless";

// What the long-running server does every ten minutes in a loop of its own, run here by the host on a
// schedule (netlify.toml): reminders for tomorrow's appointments, mail that did not go out the first time,
// and counters nobody will ask about again. Not reachable from outside: the host runs it, nobody calls it.

export const handler = async () => {
  try {
    const ctx = await serverlessContext();
    const done = await runHousekeeping(ctx);
    // Always one line, also when there was nothing to do: an empty log would not tell "idle" from "never ran".
    ctx.log?.info("housekeeping", done);
    return { statusCode: done.failed.length ? 500 : 200 };
  } catch (err) {
    console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", event: "housekeeping_start_failed", ...startFailure(err) }));
    return { statusCode: 500 };
  }
};
