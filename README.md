# Termini Dental

Online appointments for dental clinics. Patients book a time from their phone; the clinic sees its day, keeps a
report of every visit and knows who is due for a check-up. The interface is in Albanian.

Working name. Status: version 1, runs locally, not deployed.

## What it does

For patients (no account):

- Pick a service, a dentist (or "anyone free"), a day and a time on the clinic's own page (`/k/<clinic>`).
- Online booking is closed for the next 36 hours, so tomorrow's schedule never changes behind the clinic's back.
- Before confirming, the patient reads and accepts a notice: the clinic may cancel if something comes up, and
  then tells them by email, normally at least 24 hours ahead.
- A confirmation email carries a private link to view or cancel the appointment. A reminder follows the day before.

For the clinic:

- Each dentist has an account and sees only their own calendar, patients and reports. The administrator sees
  the whole clinic and manages dentists, services and the booking rules.
- Local patients (walk-ins, phone calls) are added and booked by the clinic, at any time.
- Cancelling an appointment emails the patient. Cancelling with less warning than promised needs a reason and
  is recorded as late. If the email cannot be delivered, the screen says so and shows the phone number.
- Visit reports: choose a date, see that day's patients, filter by name, open the appointment, write what was
  done. Every save is kept as a version. "Next appointment in N days" feeds a list of patients due back.
- An outbox lists every email with what is known about it: "accepted" (the mail server took it, which is not
  proof the patient received it), "stored" or "failed". A message that did not get through is tried again by
  the system while its appointment is still ahead, three attempts in all including the first; after that
  staff resend it by hand. A message the mail server is known to have accepted is never sent again, and no new attempt
  starts while an earlier one is out or within five minutes of one that timed out. Delivery is at least
  once, not exactly once: when the outcome of an attempt is unknown (it timed out after 60 seconds, or the
  process died right after the mail server took the message), the message is sent again later, and if the
  first send did get through the patient receives it twice.

The full specification, including how each open question was settled, is in [docs/SPEC.md](docs/SPEC.md).

## Run it

Needs Node 22 or newer. Nothing else: the database runs inside the server process.

```
npm install
npm run seed     # optional: creates a demo clinic
npm run dev      # API on :3101, web app on http://localhost:5180
```

With the demo data: the booking page is `http://localhost:5180/k/klinika-demo`; log in at `/kycu` as
`arta@demo.test` (administrator) or `besnik@demo.test` (dentist), password `demo12345`.

Other commands: `npm test`, `npm run typecheck`, `npm run build` (then `npm start` serves the built app and
the API together on one port). For the database: `npm run db:migrate`, `npm run db:backup -- <file>`,
`npm run db:verify-backup -- <file>`, `npm run db:restore -- <file>`.

Configuration is optional and described in [.env.example](.env.example). Without an SMTP server, emails are
not sent: they are stored and shown in the outbox, and the app says so wherever it matters.

Migrations, backups and restore, start-up checks, logs and what is still missing before a real clinic can
use it are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## How it is built

- Web: React 19, React Router, Tailwind CSS 4, Vite, TypeScript.
- Server: Node, Express 5, zod. Sessions in an httpOnly cookie, passwords hashed with scrypt.
- Database: PostgreSQL. In development and tests it is PGlite (PostgreSQL compiled to WebAssembly, in-process);
  set `DATABASE_URL` to use a real server. The SQL is the same.

Decisions worth knowing:

- **No double booking, guaranteed by the database.** An exclusion constraint refuses two live appointments
  that overlap for one dentist. Application code only translates the refusal into a message. A test sends
  three bookings for one slot at the same moment and checks that exactly one succeeds.
- **Time.** Instants are stored in UTC and shown in the clinic's timezone (Europe/Belgrade), so the switch
  between summer and winter time is handled by the zone rules. The 36-hour and 24-hour rules use real instants.
- **The server enforces every rule.** The pages mirror them, but a request sent directly gets the same answer.
- **Who sees what.** One function per kind of record decides access; "not yours" and "does not exist" give the
  same reply. Reports are attributed, versioned and written to an audit log. A patient's record and whole
  history belong to the dentist responsible for them today. A dentist who treats a colleague's patient can
  open that one appointment while it is booked and for seven days after it started, and nothing else of the
  patient. (Confirmed by the owner on 2026-10-11.)
- **The demo seed refuses real databases.** `npm run seed` stops when `DATABASE_URL` is set or
  `NODE_ENV=production`, because the demo password is public. `ALLOW_DEMO_SEED=yes` overrides it.
- **The patient's link** carries a random token; only its hash is stored, and it dies when the appointment
  starts or is cancelled.

## Known limits

- Not deployed and not tried with a real clinic. Before real patient data: hosting with backups, an email
  sender with a verified domain, a privacy notice and a data-processing agreement with the clinic (health data
  is a special category under Kosovo's Law 06/L-082).
- No password reset by email yet: an administrator sets a new password for a dentist; nobody can do it for the
  last administrator.
- Rate limits live in memory, so they are per server process.
- Out of scope for version 1: payments, tooth chart, imaging, SMS, waiting list, recurring appointments,
  several locations, patient accounts.
- The WebAssembly database needs Node's `--liftoff-only` flag on the development machine (the scripts pass it).
