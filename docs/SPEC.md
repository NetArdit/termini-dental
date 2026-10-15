# Termini Dental — product specification (version 1)

Working name. An online appointment system for dental clinics in Kosovo, sold to clinics for a monthly fee.
The interface is in Albanian. This document is the contract between the builder (Claude Code) and the
gatekeeper (Codex); the owner's rules below are fixed, everything else can be argued.

## 1. The owner's rules (fixed)

1. A patient books an appointment online. Before confirming, the patient sees a notice: the appointment may be
   cancelled if a problem comes up, and the clinic then informs them at least 24 hours before it.
2. Online booking is closed for the next 36 hours: a patient cannot book a slot that starts less than 36 hours
   from now.
3. When an appointment is cancelled, the patient is told by email.
4. The clinic can add and manage local patients itself (people who came in or phoned).
5. Every dentist in a clinic has their own account and keeps their own patients.
6. A dentist keeps a report for every appointment. Flow: pick a date, see that date's patients, filter by name,
   open the appointment, read or write what was done (for example "filling with medication, next appointment
   in 14 days").

## 2. How the rules are settled where they were open

Settled by the builder and the gatekeeper after reviewing about 30 products and guidance pages (section 7).
Each is a default the owner can overturn.

- Rule 1: the notice describes the clinic's policy. The patient must tick a box to accept it; the time of
  acceptance is stored with the appointment. The 24 hours and the 36 hours are clinic settings with those
  defaults.
- Rule 1, late cancellation: the clinic can still cancel inside the last 24 hours (emergencies happen), but the
  screen warns that this breaks the promise, a reason is required, and the cancellation is recorded as late.
- Rule 2 applies to patient self-booking only. Staff can book any future time for a local patient.
- Rule 3: every email is recorded with its outcome (sent, failed). A failed cancellation email is shown to staff
  with the patient's phone number so they can call.
- Rule 5: a patient belongs to the clinic and has one responsible dentist. A dentist sees only their own
  patients and appointments. The clinic administrator sees everything.
- Rule 6: one report per appointment, written by the treating dentist. Each save keeps the previous version.
  "Next appointment in N days" is a separate field as well as free text, so the clinic can list who is due.
- Patients do not have accounts. A booking creates a private link, sent by email, to view or cancel it.
  The link carries a long random token; only its hash is stored, and it stops working once the appointment
  has started or been cancelled.
- The notice promises 24 hours' warning as the clinic's normal practice. It says plainly that in an emergency
  the warning can be shorter.
- A staff account belongs to exactly one clinic. Signing a clinic up creates that clinic and its first
  administrator; there are no accounts shared between clinics.

## 3. Roles

- Patient (no account): books, sees the notice, receives emails, can cancel through the private link.
- Dentist: own calendar, own patients, own reports, own working hours.
- Clinic administrator: everything a dentist can do for every dentist, plus dentists, services, clinic settings.

## 4. Version 1 scope

In:
- One clinic. It and its first administrator are created from the command line (`npm run clinic:create`), never from the internet; the administrator adds dentists.
- Services (name, duration) and weekly working hours per dentist; days off.
- Public booking page per clinic: service, dentist (or "any"), day, free slot, contact details, notice, confirm.
- Calendar for staff: day view per dentist; book for a local patient; cancel; mark completed or no-show.
- Patients: list, search, add, edit, history of appointments and reports.
- Reports per appointment with version history and "next visit in N days"; day view with name filter.
- Emails: booking confirmation, cancellation (by clinic or by patient), reminder the day before.
- Basic numbers: appointments, cancellations, no-shows per period.
- Audit log of sensitive actions (report created or edited, appointment cancelled, patient edited).

Out (later): payments, invoices, insurance, tooth chart, imaging, SMS or WhatsApp, waiting list, recurring
appointments, several locations, patient accounts, integrations, advanced analytics.

## 5. Rules that must not be broken

- No double booking: the database itself refuses two active appointments that overlap for the same dentist.
  The check is never only in the browser or only in application code.
- Times are stored as instants (UTC) and shown in the clinic's timezone (Europe/Belgrade, which is Kosovo's
  civil time including daylight saving). The 36-hour and 24-hour rules use the real start instant.
- Health data: a dentist reads only their own patients' reports; every write is attributed and timestamped;
  nothing about a patient is exposed on public pages; the private link is a long random token.
- The server enforces every rule. The interface only mirrors them.

## 6. Technical decisions

- One repository, one package. Web: React 19, React Router, Tailwind CSS 4, Vite, TypeScript.
- Server: Node, Express 5, TypeScript, zod for input validation.
- Database: PostgreSQL. PGlite (PostgreSQL compiled to WebAssembly, runs inside Node, no install) for
  development and tests; any hosted PostgreSQL in production. Same SQL in both.
- Sessions in an httpOnly cookie; passwords hashed with scrypt from Node's crypto module.
- Email through one module: SMTP when configured, otherwise stored only (visible in a development outbox).
- Cost: zero for development and demo. Real clinics need a hosted database and an email sender, which have
  free tiers with limits.

## 7. Research basis

Products and pages reviewed by the two of us: Dentally, Curve Dental, Open Dental, Dentrix Ascend, CareStack,
Carestream R4+, EXACT (Software of Excellence), Dentalink, NexHealth, Weave, Fresha, Booksy, SimplyBook.me,
Setmore, Cal.com, tab32, Denticon, DigiDent, ZentraCare, EasyWeek, SchedulingKit, Anolla, MedicaSimple, Thryv;
guidance: Kosovo Law 06/L-082 on protection of personal data, EDPB guidance for small businesses, GDC and MDDUS
on dental record keeping, ADA on patient records, a systematic review on appointment reminders.
What they agree on and we adopt: service-based durations, provider choice, minimum booking notice, cancellation
deadline, automatic confirmation and reminder messages, appointment statuses including no-show, role-based
access, notes attached to the visit, attributable and timestamped clinical entries.
