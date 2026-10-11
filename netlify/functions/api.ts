import serverless from "serverless-http";
import { createApp } from "../../src/server/app";
import { serverlessContext, startFailure } from "../../src/server/serverless";

// The whole API as one Netlify function. netlify.toml sends every /api/* request here; the pages themselves
// are published as files and never reach this code.

let handle: ReturnType<typeof serverless> | undefined;

export const handler = async (event: object, context: object) => {
  try {
    handle ??= serverless(createApp(await serverlessContext()));
  } catch (err) {
    // Configuration or database trouble at start. What exactly is not for a visitor to read, and the
    // message of such an error can quote a connection string, so it is not printed either.
    console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", event: "function_start_failed", ...startFailure(err) }));
    return { statusCode: 503, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ ok: false }) };
  }
  return handle(event, context);
};
