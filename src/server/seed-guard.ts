// The demo seed creates accounts whose password is printed in the README. It must never land in a database
// that real people use, so it refuses anything that looks like one unless told to in so many words.

export const SEED_OPT_IN = "ALLOW_DEMO_SEED";

/** Why the demo seed must not run in this environment, or null when it may. */
export function seedRefusal(env: Record<string, string | undefined>): string | null {
  if (env[SEED_OPT_IN] === "yes") return null;
  if (env.DATABASE_URL) {
    return `DATABASE_URL is set, so this would write demo accounts with a publicly known password into that database. Nothing done. To do it anyway, set ${SEED_OPT_IN}=yes.`;
  }
  if (env.NODE_ENV === "production") {
    return `NODE_ENV is "production". The demo accounts have a publicly known password. Nothing done. To seed anyway, set ${SEED_OPT_IN}=yes.`;
  }
  return null;
}
