# Running Termini Dental

How to keep the application and its data safe once it runs somewhere other than a developer's laptop.
Written for one person who is not a database administrator.

Status, 2026-10-11: everything described here exists and has been tried on a developer machine, on the
built-in database, on a local PostgreSQL 18.4 and on a hosted PostgreSQL (Neon). One deployment exists: a
STAGING site on Netlify with demo data, a throwaway database and the owner's Brevo account for mail
(section 8). Nothing runs for a real clinic, and nothing here is approved for real patients. Where a step
has not been tried, it says so.

## 1. What runs

One Node process (`npm start`) serves the API and the built web app on one port. It needs Node 22 or newer
and a database:

- **Built-in database** (no `DATABASE_URL`): PostgreSQL compiled to WebAssembly, stored in the folder
  `PGLITE_DIR` (default `data/pg`). Good for development and a demo. One server process only: a second one on
  the same folder is refused at start, because it could corrupt the data.
- **A PostgreSQL server** (`DATABASE_URL` set): what a real clinic should use. Any PostgreSQL that offers the
  `btree_gist` extension, the `plpgsql` language (both standard), and a user allowed to create tables,
  triggers and that extension in its database. Tested on 18.4 only. The application uses the default
  isolation level, READ COMMITTED; do not change the database's default to something else.

Build the web app once per release with `npm run build`; `npm start` then serves it.

**Once `.env` names a hosted database, every command uses it**: `npm start`, `npm run dev`, the
`db:*` commands. To run something against a throwaway local database instead (a trial, the browser audit,
the write flows), switch the hosted one off for that one command by passing an EMPTY `DATABASE_URL`
together with a folder of its own:

    DATABASE_URL= PGLITE_DIR=/tmp/termini-scratch npm run seed
    DATABASE_URL= PGLITE_DIR=/tmp/termini-scratch PORT=3950 npm start

A variable set in the environment, even to nothing, wins over `.env`. Without the empty `DATABASE_URL` the
scratch run would read and write the hosted database. (`npm run seed` refuses a configured database on its
own; the browser flows do not.) The unit tests never read `.env`: they use the in-memory database unless
`PG_TEST_URL` is given.

## 2. Configuration

All of it comes from environment variables, or from a `.env` file next to `package.json` (copy
`.env.example`). The server reads them once at start. A setting that cannot work stops the start with a
sentence naming it; one that is risky is logged as a warning and the server runs.

- `PORT`: port to listen on. Default 3101.
- `DATABASE_URL`: `postgres://user:password@host:5432/database`. Empty means the built-in database.
- `PGLITE_DIR`: folder of the built-in database. Default `data/pg`.
- `PUBLIC_URL`: the address patients open, such as `https://termine.example.com`. It goes into the links in
  their emails. No path. In production it must be https.
- `NODE_ENV`: set to `production` on a real server. The session cookie then requires https.
- `TRUST_PROXY`: `1` (or `true`) behind a hosting proxy; `0`, `false` or empty otherwise. Anything else stops the
  start. Without it behind a proxy, every visitor seems to come from one address and the
  limits on logins and bookings count them together.
- `LOG_LEVEL`: `debug`, `info` (default), `warn`, `error`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`: the mail server. Without `SMTP_HOST` no
  email leaves the server; messages are only kept in the outbox, and the owner's rule that a cancelled
  patient is told by email is not met. With it, `MAIL_FROM` must be a sender the provider has verified.
- `RATE_LIMIT_SECRET`: optional. The limits on failed logins (8 in 15 minutes per email and address) and on
  online bookings (6 an hour per address) keep their counters in the database when `DATABASE_URL` is set, so
  that they hold across several instances of the server; with the built-in database they are in memory. The
  counters are stored under a keyed hash, not under an email or network address; this is the key. When empty
  it is derived from `DATABASE_URL`.
- `ALLOW_DEMO_SEED`: leave empty. `npm run seed` refuses a configured or production database without it,
  because the demo accounts have a public password.

Secrets (`DATABASE_URL`, `SMTP_PASS`) belong in the host's secret settings or in `.env` on the server, never
in git, a chat or a screenshot. (That rule was broken once: on 2026-10-11 the Brevo SMTP key was pasted
into a chat. It serves the staging site only and must be replaced by a new key before any real use.)
The start-up log shows the database's host and name and whether a mail login
is set; it never shows a password, a user name or the sender address.

Check a running server with `GET /api/health`: `{"ok":true,"schemaVersion":1,"mail":"configured"}`, or
status 503 when the database does not answer. It reveals nothing about any clinic.

## 3. Changes to the database (migrations)

The tables are defined by the numbered files in `src/server/migrations`. Each is applied once, in order, in
its own transaction; the table `schema_migrations` records which a database has had. The server applies what
is pending when it starts. `npm run db:migrate` does the same by hand and reports the version.

To change the tables:

1. Add a file with the next number, `NNN_short_name.sql`. Never edit a file that has been applied anywhere.
2. Write it so that existing data survives: add columns with defaults, backfill, then tighten.
3. Run `npm test`. With a PostgreSQL server at hand also `PG_TEST_URL=postgres://... npm test`.
4. Take a backup before releasing it (section 4). A migration has no automatic way back: undoing one means
   restoring that backup with the previous version of the application.

What the server refuses, on purpose:

- A database that has a migration this version does not know (the application was downgraded). Start the
  newer version, or restore a backup from before the upgrade.
- A database whose applied migration differs from the file (someone edited it). Put the file back.
- A migration that fails: it is rolled back whole, the version stays, and the server does not start.

A database created before migrations existed has no `schema_migrations` table. Migration 001 is written to
run on such a database and on an empty one, so it is simply adopted at the next start. Tried on a copy of
the developer's older local database.

Not tried: migrations on a hosted database; two servers starting at the same moment (an advisory lock makes
them take turns, by design).

## 4. Backups

A dental record that is lost is lost for the patient too. Decide who makes backups and where they are kept
before the first real patient is entered.

### The application's own backup

    npm run db:backup -- backups/2026-10-11.json

writes every record of every clinic into one JSON file: clinics, staff (with password hashes), services,
working hours, time off, patients, appointments, reports and their versions, the email log, the audit log.
Not included: who is logged in (everybody logs in again after a restore).

It works the same on the built-in database and on a PostgreSQL server, and needs no database tools on the
machine. With the built-in database, stop the server first (one process at a time). On a PostgreSQL server
it can run while the clinic works; it reads everything as of one moment.

**Check every backup you intend to rely on:**

    npm run db:verify-backup -- backups/2026-10-11.json

restores the file into a scratch database in memory, reads it back and compares every record. It touches
nothing configured. A backup that has never been restored is a hope, not a backup.

**The file contains patient data, unencrypted.** Keep it where patient records may lawfully be kept, not in
a shared cloud folder or a chat. `backups/` is ignored by git. Encrypting it and moving a copy off the
server are up to the operator; neither is automated here.

Nothing runs backups on a schedule. Until someone sets that up on the host, it is a manual task; daily is a
sensible minimum for a working clinic.

### Restoring

    npm run db:restore -- backups/2026-10-11.json

puts the file into the configured database, all of it or none of it. It refuses:

- a database that is not empty (it never merges into existing records);
- a file that is not a complete backup;
- a backup from another schema version. Restore with the application version that made the backup, into an
  empty database, then upgrade; that way the migrations in between are applied to the data.

To recover a clinic: provide an empty database (a new `PGLITE_DIR`, or a new database on the server), point
the configuration at it, run `db:restore`, start the server, check `/api/health`, log in, and open a patient
whose last visit you know.

Moving from the built-in database to a PostgreSQL server is the same procedure: back up from one, restore
into the other. The automated tests back up and restore within each kind (built-in to built-in, PostgreSQL
to PostgreSQL). From one kind to the other has NOT been tried.

### Rehearsing it on the hosted server

    node e2e/rehearse-backup.mjs

runs the whole chain with throwaway data and the application's own commands: a scratch built-in database
with the demo clinic is backed up and verified; the file is restored into an empty database on the hosted
server (built-in to hosted, across the two kinds); that database is backed up and compared record for
record; that backup is restored into a second, separate empty hosted database, backed up and compared
again; the result is checked (the clinic and its records, nobody logged in, id counters past the highest
restored id). It makes two databases of its own on the server and drops them, removes its files, and never
touches the application's own database. It exits with status 1 if any step fails.

Passed on 2026-10-11 against the Neon project (PostgreSQL 18.6): 50 rows, the same after each hop. The
first run failed, usefully: the two kinds of database wrote the same instant in different timezones
(`+01:00` and `+00:00`), and the comparison looked at the text. Backups are now always written in UTC and
compared by instant. Run it again after any change to the tables or to `src/server/backup.ts`.

What this does not give you is a backup. It shows that the mechanism works. Still to be decided by the
owner before a real patient is entered, at zero cost:

- **Who runs `npm run db:backup`, how often, and from where.** Nothing runs it. On a PC that is on during
  clinic hours, Windows Task Scheduler can run it daily for free; a PC that is off makes no backup.
- **Where the files are kept.** They hold patient data unencrypted. A second place than the PC that made
  them (an encrypted USB drive kept at the clinic, for instance), and not a personal cloud folder.
- **How many are kept**, and who checks one with `db:verify-backup` now and then.

Neon's free plan keeps six hours of history for its own point-in-time restore (read from the project's
settings on 2026-10-11; not tried). That covers a mistake noticed the same morning, not a clinic's records.

### On a hosted PostgreSQL

Use the provider's own backups as the first line (most offer daily snapshots and point-in-time recovery;
check what the free tier includes) and `pg_dump` as the second. Taking a dump only reads:

    pg_dump --format=custom --file=termini-2026-10-11.dump "$DATABASE_URL"

Restoring a dump is the dangerous half. **Restore into a new, empty database, never into the one the clinic
is using.** Create a scratch database with the provider, put ITS address in a separate variable, and
restore there:

    pg_restore --no-owner --dbname="$SCRATCH_DATABASE_URL" termini-2026-10-11.dump

Check the result (point a server at it, open a known patient), and only then switch the application's
`DATABASE_URL` to the restored database. Do not add `--clean` unless you mean it: with `--clean`,
`pg_restore` DROPS every table it is about to restore before recreating it, so pointed at the live database
it destroys whatever was entered since the dump. There is no undo.

Neither command has been tried for this project: no hosted database exists yet and the PostgreSQL client
tools are not installed on the developer machine.

## 5. Logs

The server writes one JSON object per line: informational lines to standard output, warnings and errors to
standard error. Any host's log viewer can filter them.

    {"time":"...","level":"info","event":"request","requestId":"26d71a24","method":"GET","route":"/api/patients","status":200,"ms":39,"userId":1,"clinicId":1}

Events: `starting` (the configuration, without secrets), `configuration` (a warning), `database_ready`,
`listening`, `request` (every API request), `unexpected_error`, `reminders`, `email_retries`, and their
`_failed` forms, `stopping`, `stopped`.

What is never logged, by construction: request and response bodies, query strings, raw addresses (a request
is named by its route pattern, so a patient's private link or a searched name cannot appear), names, phone
numbers, email addresses, report texts, passwords, keys, connection strings, and the database's or mail
server's own error text (which can quote data). People and records appear as numeric ids. An unexpected
error is logged by its class, its code and the lines of this application it passed through.

When a clinic reports "something went wrong": the error message on their screen carries a request id
(`requestId`), also sent as the `X-Request-Id` header. Search the log for it.

To find out what happened to a patient's record, use the audit log table in the database, not these logs:
it records who created or edited a report, cancelled an appointment, edited a patient or resent an email.

Logs are not kept by the application. How long the host keeps them is the host's setting.

## 6. Stopping and restarting

On SIGTERM or SIGINT the server stops accepting requests, lets open ones finish (ten seconds at most),
closes the database and exits. A server that is killed outright leaves a `termini.lock` file in the built-in
database's folder; the next start sees that the process is gone and takes over.

Tried: start, health check, a second server on the same folder being refused, restart after a forced kill.
Not tried: the graceful path itself (Windows cannot deliver SIGTERM to a Node process), and any host's
restart behaviour.

## 7. Before a real clinic uses it

None of this is done, and none of it is the developer's to decide alone:

- A host and a PostgreSQL database, with https and backups arranged and a restore actually tried.
- A mail sender with a verified domain, so that cancellations reach patients.
- A privacy notice for patients, and a data-processing agreement between the operator and the clinic.
  Patient records are health data under Kosovo's Law 06/L-082; no legal review has been done.
- Someone named as responsible for backups, and for reading the error log.
- A password-reset path: today an administrator resets a dentist's password, and nobody can reset the last
  administrator's.

## 8. Netlify (staging)

A second way to run the application, beside the long-running server of section 1: the pages are published
as files, the API runs as one function, and what the server does in a ten-minute loop runs as a scheduled
function. It exists as a STAGING site with demo data. It is not approved for real patients: see "Before real
patients" at the end of this section.

What is where:

- `netlify.toml`: build (`npm run build`, publish `dist/web`), `/api/*` to the function, a missing file under
  `/assets/` answers 404, every other address is the single-page app, the security headers and the one-year
  cache for `/assets/`.
- `netlify/functions/api.ts`: the Express application behind `serverless-http`.
- `netlify/functions/housekeeping.ts`: reminders, mail retries, expired counters. Hourly (`@hourly`), not
  every ten minutes: each run wakes the database, and the free database plan counts the time it is awake.
  A reminder therefore goes out between 23 and 24 hours before the appointment, and a message that failed
  is retried within the hour.
- `src/server/serverless.ts`: what such a function needs instead of `main.ts`. A database server is required
  (never the built-in database, which is not even packaged with the function); migrations are NOT applied
  at start; at most 2 connections per copy of the function; the limits on logins and bookings are counted
  in the database; the visitor's address is read from `x-nf-client-connection-ip`, which Netlify sets
  itself, and never from `X-Forwarded-For`, which a visitor can write.

The staging site as set up on 2026-10-11:

- Site `<staging-site>` (free plan), https://<staging-site>.netlify.app. Functions run in
  the United States (Ohio); the free plan offers no other region.
- Database: a separate Neon project, `<staging-site>` (`<staging-project-id>`, Frankfurt,
  PostgreSQL 18), holding the demo clinic only. It is NOT the owner's database (`termini-dental`,
  `<owner-project-id>`), which nothing on Netlify knows about.
- Variables on the site: `DATABASE_URL` (the pooled address of the staging database, `sslmode=verify-full`)
  and `RATE_LIMIT_SECRET`, both stored as secrets in the production context (the free plan does not offer
  limiting a variable to functions; `netlify env:set ... --scope` fails there without saying so, so check
  with `netlify env:list` that a variable is really stored); `NODE_ENV=production`; `PUBLIC_URL`.
  Mail: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `MAIL_FROM` and, as a secret, `SMTP_PASS` (Brevo), copied
  from `.env` on 2026-10-11 at the owner's instruction. Run `e2e/quiet-staging-mail.ts` first whenever demo
  data is seeded again: its example.test addresses would bounce.

A release, in this order (the commands as they were run; none prints a secret):

    # 1. The schema first, as a step of its own, against the database the site uses.
    DATABASE_URL="$(npx neonctl connection-string --project-id <project> --org-id <org>)" npm run db:migrate
    # 2. Then the code.
    netlify deploy --prod --build

A migration must leave the release that is serving at that moment working (add before you use, remove only
after nothing uses it): between step 1 and step 2, and for good if step 2 fails, the old code runs on the
new schema.

Mail on Netlify (for the owner; the developer never sees these values): in the Netlify site, under
Project configuration, Environment variables, add `SMTP_HOST` = `smtp-relay.brevo.com`, `SMTP_PORT` = `587`,
`SMTP_USER` and `SMTP_PASS` (Brevo: SMTP & API, SMTP tab; the SMTP key, not the account password; mark
`SMTP_PASS` as secret), and `MAIL_FROM` (the sender verified in Brevo, in the form
`Klinika <adresa@example.org>`). Then publish again. `/api/health` then answers `"mail":"configured"`.

Known limits of this way of running:

- A scheduled function may run 30 seconds; a mail server that hangs is given 60. A run cut off in the
  middle leaves the message claimed for five minutes and it is sent on a later run: at least once, as
  everywhere else, never silently dropped.
- A function that has not been used for a while starts cold, and the database may be asleep: the first
  request after a quiet period takes seconds, not milliseconds.
- Every database round trip crosses the Atlantic (function in Ohio, database in Frankfurt).

Before real patients (none of it done): the owner's explicit approval that requests are processed in the
United States; mail configured and seen to arrive; the owner's own database and clinic instead of the demo;
and everything in section 7.
