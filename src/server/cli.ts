import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BackupError, exportBackup, parseBackup, restoreBackup, sameContent } from "./backup";
import { ConfigError, readConfig } from "./config";
import { MigrationError, loadMigrations, openPostgres, type Db } from "./db";
import { openPglite } from "./db-local";

// Maintenance commands, run by hand:
//   npm run db:migrate                      apply pending migrations and say where the database stands
//   npm run db:backup -- <file>             write every record to <file>
//   npm run db:verify-backup -- <file>      restore <file> into a scratch database in memory and compare
//   npm run db:restore -- <file>            put <file> into the configured database, which must be empty
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

const [command, file] = process.argv.slice(2);

try {
  if (command === "migrate") {
    const { db, where } = await openConfigured();
    // Opening the database applies what is pending; asking again reports where it stands.
    const report = await db.migrate();
    console.log(`${where}: schema version ${report.current} of ${loadMigrations().length}. Nothing is pending.`);
    await db.close();
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
    fail("Commands: migrate | backup <file> | verify-backup <file> | restore <file>");
  }
} catch (err) {
  if (err instanceof BackupError || err instanceof MigrationError || err instanceof ConfigError) fail(err.message);
  throw err;
}
