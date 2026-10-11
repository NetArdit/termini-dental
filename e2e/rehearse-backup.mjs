// A full rehearsal of backup and restore on the server in DATABASE_URL (.env), with throwaway data only.
//   node e2e/rehearse-backup.mjs
// It never touches the application's own database on that server: it makes two databases of its own,
// uses them, and drops them. The data is the synthetic demo clinic, seeded into a scratch built-in database.
//
//   1. scratch built-in database  -- seed, backup --> file 1          (the application's own command)
//   2. file 1                     -- verify -->                       (restore in memory, compare)
//   3. file 1                     -- restore --> hosted database A    (built-in to hosted: across engines)
//   4. hosted database A          -- backup --> file 2, compare with file 1
//   5. file 2                     -- restore --> hosted database B    (hosted to hosted, a separate empty one)
//   6. hosted database B          -- backup --> file 3, compare with file 2
//   7. B is checked: the clinic and its records are there, nobody is logged in, the id counters are past
//      the highest restored id. Then A, B, the scratch folder and the files are removed.
// Prints no secret. Exits with status 1 if any step fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}
const serverUrl = process.env.DATABASE_URL;
if (!serverUrl) {
  console.error("DATABASE_URL is not set: there is no hosted server to rehearse on.");
  process.exit(1);
}
const work = mkdtempSync(path.join(tmpdir(), "termini-rehearsal-"));
const stamp = Date.now();
const names = { a: `termini_rehearsal_a_${stamp}`, b: `termini_rehearsal_b_${stamp}` };
const urlFor = (database) => {
  const u = new URL(serverUrl);
  u.pathname = `/${database}`;
  return u.toString();
};
const hide = (text) => String(text).replace(/postgres(ql)?:\/\/\S+/g, "<connection string>").replace(/[A-Z]:[\\/][^\s"']*termini-rehearsal-[^\s"'\\/]*/gi, "<work>");

/** Runs one of the application's own commands and returns its last meaningful line. */
function run(label, env, ...args) {
  const res = spawnSync("npx", ["tsx", "--liftoff-only", ...args], { env: { ...process.env, ...env }, encoding: "utf8", shell: true });
  const lines = `${res.stdout}\n${res.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/Warning:|sslmode|libpq|trace-warnings|prepare for this change|^- If you want|^See https/.test(l));
  if (res.status !== 0) throw new Error(`${label} failed (status ${res.status}): ${hide(lines.slice(-3).join(" | "))}`);
  console.log(`  ok  ${label}: ${hide(lines.at(-1) ?? "")}`);
  return lines;
}

/** Record-for-record comparison of two backup files, by the application's own function. */
function same(one, two) {
  const res = spawnSync("npx", ["tsx", "-e", `"import('./src/server/backup.ts').then(async (m) => { const fs = await import('node:fs'); const r = m.sameContent(m.parseBackup(fs.readFileSync(process.argv[1], 'utf8')), m.parseBackup(fs.readFileSync(process.argv[2], 'utf8'))); console.log(JSON.stringify(r)); })"`, one, two], { encoding: "utf8", shell: true });
  const out = res.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let verdict;
  try {
    verdict = JSON.parse(out);
  } catch {
    throw new Error(`could not compare the two files: ${hide(res.stderr.trim().split(/\r?\n/).at(-1) ?? out)}`);
  }
  if (!verdict.same) throw new Error(`the two backups differ: ${verdict.firstDifference}`);
}

const rows = (file) => Object.values(JSON.parse(readFileSync(file, "utf8")).tables).reduce((n, t) => n + t.length, 0);
const admin = new pg.Client({ connectionString: serverUrl });
let failed = false;
try {
  await admin.connect();
  const [f1, f2, f3] = ["1-built-in.json", "2-hosted-a.json", "3-hosted-b.json"].map((f) => path.join(work, f));
  const scratch = { DATABASE_URL: "", PGLITE_DIR: path.join(work, "pg") };

  console.log("1. A scratch built-in database with the demo clinic, backed up");
  run("seed", scratch, "src/server/seed.ts");
  run("backup", scratch, "src/server/cli.ts", "backup", f1);

  console.log("2. The backup file is verified (restored in memory and compared)");
  run("verify", scratch, "src/server/cli.ts", "verify-backup", f1);

  console.log("3. Restored into an empty database on the hosted server (built-in to hosted)");
  await admin.query(`CREATE DATABASE ${names.a}`);
  run("migrate A", { DATABASE_URL: urlFor(names.a) }, "src/server/cli.ts", "migrate");
  run("restore into A", { DATABASE_URL: urlFor(names.a) }, "src/server/cli.ts", "restore", f1);

  console.log("4. The hosted database is backed up and compared with what went in");
  run("backup A", { DATABASE_URL: urlFor(names.a) }, "src/server/cli.ts", "backup", f2);
  same(f1, f2);
  console.log(`  ok  ${rows(f2)} rows, record for record the same as the built-in backup`);

  console.log("5. That backup restored into a second, separate empty hosted database");
  await admin.query(`CREATE DATABASE ${names.b}`);
  run("migrate B", { DATABASE_URL: urlFor(names.b) }, "src/server/cli.ts", "migrate");
  run("restore into B", { DATABASE_URL: urlFor(names.b) }, "src/server/cli.ts", "restore", f2);

  console.log("6. The second database is backed up and compared");
  run("backup B", { DATABASE_URL: urlFor(names.b) }, "src/server/cli.ts", "backup", f3);
  same(f2, f3);
  console.log(`  ok  ${rows(f3)} rows, record for record the same`);

  console.log("7. The restored database holds the clinic and its records, no sessions, and id counters past the highest id");
  const b = new pg.Client({ connectionString: urlFor(names.b) });
  await b.connect();
  const facts = (await b.query("SELECT (SELECT count(*)::int FROM clinics) AS clinics, (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM visit_reports) AS reports, (SELECT count(*)::int FROM sessions) AS sessions, (SELECT max(id)::int FROM patients) AS top, (SELECT last_value::int FROM pg_sequences WHERE sequencename = 'patients_id_seq') AS seq")).rows[0];
  await b.end();
  if (!(facts.clinics === 1 && facts.patients > 0 && facts.reports > 0 && facts.sessions === 0 && facts.seq >= facts.top)) throw new Error(`the restored database does not look right: ${JSON.stringify(facts)}`);
  console.log(`  ok  ${JSON.stringify(facts)} (nobody logged in; the id counter is past the highest restored id)`);
  console.log("\nREHEARSAL PASSED");
} catch (err) {
  failed = true;
  console.error(`\nREHEARSAL FAILED: ${hide(err instanceof Error ? err.message : err)}`);
} finally {
  // Whatever happened, nothing of the rehearsal stays behind on the server or on this machine.
  for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  const left = await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'termini_rehearsal_%'").catch(() => ({ rows: [{ n: "unknown" }] }));
  await admin.end().catch(() => {});
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  console.log(`cleaned up: rehearsal databases left on the server: ${left.rows[0].n}; local files removed: ${!existsSync(work)}`);
  process.exit(failed ? 1 : 0);
}
