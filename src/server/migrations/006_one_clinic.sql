-- Termini Dental, migration 006: this is the application of ONE clinic.
--
-- It began as a product that any number of clinics could sign up to, each with a page of its own at an
-- address made from its name (the "slug"). It is now the site and the tool of a single clinic. Three things
-- follow, and the database is where they are made true whatever the code above it does:
--
--   1. A database that holds more than one clinic is not converted. This migration stops before it changes
--      anything (a migration runs in one transaction), and says so. Which clinic stays is a person's
--      decision, never this file's: nothing is ever deleted here.
--   2. There can be no second clinic. Every clinic row carries the same constant in a column that must be
--      unique, so the database itself refuses a second row, from any code path or by hand.
--   3. The slug is gone: no page and no address is named after a clinic any more.

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM clinics;
  IF n > 1 THEN
    RAISE EXCEPTION 'This database holds % clinics. The application now serves exactly one. Nothing was changed: decide which clinic stays and move the others out before migrating.', n;
  END IF;
END $$;

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS the_only_one BOOLEAN NOT NULL DEFAULT TRUE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clinics_the_only_one_check') THEN
    ALTER TABLE clinics ADD CONSTRAINT clinics_the_only_one_check CHECK (the_only_one);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS clinics_the_only_one_idx ON clinics (the_only_one);

ALTER TABLE clinics DROP COLUMN IF EXISTS slug;
