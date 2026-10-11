-- Termini Dental, migration 001: the schema as it stood when versioned migrations were introduced.
-- It runs on an empty database and on one created by the earlier, unversioned schema file (every statement
-- checks before it acts), which is how existing databases are adopted. Do not edit it: add a new migration.
-- All instants are timestamptz (stored in UTC); calendar logic happens in the clinic's timezone in the application.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS clinics (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Belgrade',
  -- Owner's rule 2: patients cannot book a slot that starts sooner than this many hours from now.
  booking_notice_hours INTEGER NOT NULL DEFAULT 36 CHECK (booking_notice_hours BETWEEN 0 AND 720),
  -- Owner's rule 1: the clinic promises to warn the patient this many hours before a cancelled appointment.
  cancel_notice_hours INTEGER NOT NULL DEFAULT 24 CHECK (cancel_notice_hours BETWEEN 0 AND 720),
  slot_step_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_step_minutes IN (10, 15, 20, 30, 60)),
  -- How far ahead patients may book.
  booking_horizon_days INTEGER NOT NULL DEFAULT 60 CHECK (booking_horizon_days BETWEEN 1 AND 365),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'dentist')),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  -- Whether patients can be booked with this person. An administrator who is also a dentist is bookable.
  is_bookable BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_clinic_idx ON users (clinic_id);

-- A clinic must never be left without an active administrator: nobody could manage it again.
-- The database itself holds this, whatever the application does and however many requests arrive at once.
-- The check runs when the transaction commits (so a clinic and its first administrator can be created
-- together, and two administrators can be swapped in one step). It first locks the clinic's row, which makes
-- transactions that touch the same clinic's administrators commit one after the other; each then sees what
-- the previous one committed. FOR NO KEY UPDATE: it does not hold up bookings or new patients of the clinic.
CREATE OR REPLACE FUNCTION clinic_keeps_an_administrator() RETURNS trigger AS $$
DECLARE
  clinic INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'clinics' THEN
    clinic := NEW.id;
  ELSIF TG_OP = 'INSERT' THEN
    clinic := NEW.clinic_id;
  ELSE
    clinic := OLD.clinic_id;
  END IF;
  PERFORM 1 FROM clinics WHERE id = clinic FOR NO KEY UPDATE;
  -- The clinic itself is gone (deleted together with its staff): nothing left to protect.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE clinic_id = clinic AND role = 'admin' AND is_active) THEN
    RAISE EXCEPTION 'clinic % would be left without an active administrator', clinic USING ERRCODE = 'TD001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_clinic_keeps_an_administrator') THEN
    CREATE CONSTRAINT TRIGGER users_clinic_keeps_an_administrator
      AFTER UPDATE OF role, is_active, clinic_id OR DELETE ON users
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clinic_keeps_an_administrator();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinics_start_with_an_administrator') THEN
    CREATE CONSTRAINT TRIGGER clinics_start_with_an_administrator
      AFTER INSERT ON clinics
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clinic_keeps_an_administrator();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS services_clinic_idx ON services (clinic_id);

-- Weekly working hours. weekday is ISO: 1 = Monday ... 7 = Sunday. Minutes are counted from local midnight.
CREATE TABLE IF NOT EXISTS working_hours (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (end_minute > start_minute)
);
CREATE INDEX IF NOT EXISTS working_hours_user_idx ON working_hours (user_id);

CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS time_off_user_idx ON time_off (user_id, starts_at);

-- A patient belongs to the clinic and has one responsible dentist.
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  dentist_id INTEGER NOT NULL REFERENCES users(id),
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  birth_date DATE,
  note TEXT,
  -- 'online': created by a patient's own booking. 'local': added by the clinic.
  source TEXT NOT NULL CHECK (source IN ('online', 'local')),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patients_clinic_idx ON patients (clinic_id, dentist_id);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  dentist_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'completed', 'no_show', 'cancelled')),
  source TEXT NOT NULL CHECK (source IN ('online', 'local')),
  -- When the patient ticked the cancellation notice (online bookings only).
  notice_accepted_at TIMESTAMPTZ,
  -- SHA-256 of the private link token sent to the patient. The token itself is never stored.
  token_hash TEXT UNIQUE,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT CHECK (cancelled_by IN ('clinic', 'patient')),
  cancelled_by_user INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  -- True when the clinic cancelled with less warning than it promises.
  cancel_late BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_sent_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- The rule that must never break: one dentist cannot have two live appointments that overlap.
  -- Enforced here so that no race between two requests, and no bug in the application, can get past it.
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    dentist_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status <> 'cancelled')
);
CREATE INDEX IF NOT EXISTS appointments_clinic_time_idx ON appointments (clinic_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_patient_idx ON appointments (patient_id);

-- One report per appointment; every save also lands in visit_report_versions.
CREATE TABLE IF NOT EXISTS visit_reports (
  appointment_id INTEGER PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  work_done TEXT NOT NULL,
  next_visit_days INTEGER CHECK (next_visit_days BETWEEN 1 AND 730),
  version INTEGER NOT NULL DEFAULT 1,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visit_report_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  work_done TEXT NOT NULL,
  next_visit_days INTEGER,
  author_id INTEGER NOT NULL REFERENCES users(id),
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, version)
);

-- Every email the system tried to send, with its outcome.
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('booking_confirmation', 'cancelled_by_clinic', 'cancelled_by_patient', 'reminder')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  -- 'accepted': the mail server took it (not proof that the patient received it).
  -- 'stored': written down, not handed to a mail server. 'failed': the mail server refused or was unreachable.
  status TEXT NOT NULL CONSTRAINT email_log_status_check CHECK (status IN ('accepted', 'stored', 'failed')),
  error TEXT,
  -- How many times the message was handed to the mail server, and when last.
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TIMESTAMPTZ,
  -- Set while an attempt is sending this message, cleared when it knows the outcome. Nobody else may
  -- start a send meanwhile. A value left behind by a process that died stops counting after five minutes.
  sending_since TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_clinic_idx ON email_log (clinic_id, created_at);

-- Databases created before October 2026 called the first status 'sent', which claimed more than is known,
-- and had no attempt columns. Safe to run on every start: each step does nothing once it has been done.
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS sending_since TIMESTAMPTZ;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM email_log WHERE status = 'sent') OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_log_status_check' AND pg_get_constraintdef(oid) LIKE '%accepted%'
  ) THEN
    ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_status_check;
    UPDATE email_log SET status = 'accepted' WHERE status = 'sent';
    ALTER TABLE email_log ADD CONSTRAINT email_log_status_check CHECK (status IN ('accepted', 'stored', 'failed'));
  END IF;
END $$;
-- Finds what is still waiting to be sent without reading the whole log.
CREATE INDEX IF NOT EXISTS email_log_pending_idx ON email_log (id) WHERE status IN ('stored', 'failed');

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_clinic_idx ON audit_log (clinic_id, created_at);
