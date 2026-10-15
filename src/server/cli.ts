import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { BackupError, exportBackup, parseBackup, restoreBackup, sameContent } from "./backup";
import { BootstrapError, checkFirstSetup, createClinic, setPasswordByHand } from "./bootstrap";
import { ConfigError, readConfig } from "./config";
import { MigrationError, loadMigrations, openPostgres, type Db } from "./db";
import { openPglite } from "./db-local";

// Maintenance commands, run by hand:
//   npm run db:migrate                      apply pending migrations and say where the database stands
//   npm run db:backup -- <file>             write every record to <file>
//   npm run db:verify-backup -- <file>      restore <file> into a scratch database in memory and compare
//   npm run db:restore -- <file>            put <file> into the configured database, which must be empty
//   npm run clinic:create                   set the clinic up: its name and its first administrator (asks)
//   npm run staff:password                  set a new password for one member of staff (asks); for an
//                                           administrator who cannot be sent a link
// They use the same configuration as the server (.env). Stop the server first when it uses the built-in
// database: that database allows one process at a time.

try {
  process.loadEnvFile();
} catch {
  // No .env file: defaults apply.
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function openConfigured(): Promise<{ db: Db; where: string }> {
  const { config } = readConfig(process.env);
  if (config.databaseUrl) return { db: await openPostgres(config.databaseUrl), where: "the PostgreSQL server in DATABASE_URL" };
  const dir = path.resolve(config.pgliteDir);
  mkdirSync(dir, { recursive: true });
  return { db: await openPglite(dir), where: `the built-in database in ${dir}` };
}

/**
 * Asks on the terminal. A secret is not shown while it is typed, and is never taken from the command line:
 * what is typed there stays in the shell's history and shows in the list of running programs.
 * Without a terminal (a script feeding the answers), the answers are read line by line from the input.
 */
async function ask(questions: Array<{ key: string; label: string; secret?: boolean; fallback?: string }>): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  if (!process.stdin.isTTY) {
    const lines: string[] = [];
    for await (const line of createInterface({ input: process.stdin })) lines.push(line);
    questions.forEach((q, i) => (answers[q.key] = lines[i] ?? q.fallback ?? ""));
    return answers;
  }
  let hidden = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // The line editor echoes every key through this function: while a secret is typed, it writes nothing.
  const out = rl as unknown as { _writeToOutput(text: string): void };
  const write = out._writeToOutput.bind(rl);
  out._writeToOutput = (text: string) => {
    if (!hidden) write(text);
  };
  try {
    for (const q of questions) {
      const label = `${q.label}${q.fallback ? ` [${q.fallback}]` : ""}: `;
      process.stdout.write(label);
      hidden = !!q.secret;
      const answer = await new Promise<string>((resolve) => rl.question("", resolve));
      hidden = false;
      if (q.secret) process.stdout.write("\n");
      answers[q.key] = answer || q.fallback || "";
    }
  } finally {
    rl.close();
  }
  return answers;
}

const [command, file] = process.argv.slice(2);

try {
  if (command === "migrate") {
    const { db, where } = await openConfigured();
    // Opening the database applies what is pending; asking again reports where it stands.
    const report = await db.migrate();
    console.log(`${where}: schema version ${report.current} of ${loadMigrations().length}. Nothing is pending.`);
    await db.close();
  } else if (command === "clinic:create") {
    if (process.argv.length > 3) fail("This command takes no arguments: it asks. (A password on the command line would stay in the shell's history.)");
    const { db, where } = await openConfigured();
    try {
      if ((await db.query("SELECT 1 FROM clinics LIMIT 1")).length) fail(`${where} already has its clinic. Nothing was changed. Staff are added by the administrator, in the application.`);
      console.log(`Setting up the clinic in ${where}.`);
      const a = await ask([
        { key: "clinicName", label: "Name of the clinic", fallback: "Rrënja Dental" },
        { key: "adminName", label: "Administrator's full name" },
        { key: "adminEmail", label: "Administrator's email" },
        { key: "isDentist", label: "Does the administrator treat patients? (po/jo)", fallback: "po" },
        { key: "password", label: "Password (8 characters or more, not shown)", secret: true },
        { key: "again", label: "The same password again", secret: true },
      ]);
      if (a.password !== a.again) fail("The two passwords differ. Nothing was changed.");
      const setup = checkFirstSetup({ clinicName: a.clinicName!, adminName: a.adminName!, adminEmail: a.adminEmail!, password: a.password!, isDentist: !/^(jo|no|n)$/i.test(a.isDentist!.trim()) });
      await createClinic(db, setup);
      console.log(`${setup.clinicName} is set up. ${setup.adminName} can sign in with ${setup.adminEmail}.`);
    } finally {
      await db.close();
    }
  } else if (command === "staff:password") {
    if (process.argv.length > 3) fail("This command takes no arguments: it asks. (A password on the command line would stay in the shell's history.)");
    const { db, where } = await openConfigured();
    try {
      console.log(`Setting a new password in ${where}.`);
      const a = await ask([
        { key: "email", label: "Email of the member of staff" },
        { key: "password", label: "New password (8 characters or more, not shown)", secret: true },
        { key: "again", label: "The same password again", secret: true },
      ]);
      if (a.password !== a.again) fail("The two passwords differ. Nothing was changed.");
      const who = await setPasswordByHand(db, a.email!, a.password!);
      console.log(`${who.fullName} has a new password and was signed out everywhere.`);
    } finally {
      await db.close();
    }
  } else if (command === "backup") {
    if (!file) fail("Say where to write the backup:  npm run db:backup -- backups/2026-10-10.json");
    if (existsSync(file)) fail(`${file} already exists. Choose another name; a backup is never overwritten.`);
    const { db, where } = await openConfigured();
    const backup = await exportBackup(db, new Date());
    await db.close();
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, JSON.stringify(backup));
    const rows = Object.values(backup.tables).reduce((n, t) => n + t.length, 0);
    console.log(`Backup of ${where} written to ${file}: ${rows} rows, schema version ${backup.schemaVersion}.`);
    console.log("It contains patient data in the clear. Check it with:  npm run db:verify-backup -- " + file);
  } else if (command === "verify-backup") {
    if (!file || !existsSync(file)) fail("Name an existing backup file:  npm run db:verify-backup -- backups/2026-10-10.json");
    const backup = parseBackup(readFileSync(file, "utf8"));
    // A scratch database in memory: nothing configured is touched.
    const scratch = await openPglite();
    const counts = await restoreBackup(scratch, backup);
    const again = await exportBackup(scratch, new Date());
    await scratch.close();
    const check = sameContent(backup, again);
    if (!check.same) fail(`The backup did NOT restore to the same records: ${check.firstDifference}. Do not rely on this file.`);
    console.log(`Backup ${file} (made ${backup.createdAt}, schema version ${backup.schemaVersion}) restores completely:`);
    for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(22)} ${n}`);
  } else if (command === "restore") {
    if (!file || !existsSync(file)) fail("Name an existing backup file:  npm run db:restore -- backups/2026-10-10.json");
    const backup = parseBackup(readFileSync(file, "utf8"));
    const { db, where } = await openConfigured();
    const counts = await restoreBackup(db, backup);
    await db.close();
    console.log(`Restored ${file} into ${where}:`);
    for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(22)} ${n}`);
    console.log("Nobody is logged in after a restore: sessions are not part of a backup.");
  } else {
    fail("Commands: migrate | clinic:create | staff:password | backup <file> | verify-backup <file> | restore <file>");
  }
} catch (err) {
  if (err instanceof BootstrapError) fail(err.message);
  if (err instanceof BackupError || err instanceof MigrationError || err instanceof ConfigError) fail(err.message);
  throw err;
}
