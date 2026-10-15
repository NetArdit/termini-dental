-- Termini Dental, migration 013: "Punët tona", the clinic's gallery on its public pages.
--
-- A picture of somebody's teeth is health data about a person even when no face is on it. So every item says
-- what allows it to be shown, and the database itself keeps it off the public pages without that:
--   - 'illustrative': a stock or drawn picture that shows no patient of this clinic. It is always labelled as
--     such on the public page, so that it never passes for the clinic's own result;
--   - 'patient': a picture of a patient's treatment. It can be published only with a recorded consent: the
--     day it was given, where the signed form is kept, and who recorded it. The patient's name is not kept
--     here and is never shown.
-- Consent can be taken back. A revoked item cannot be published (the CHECK below), and revoking unpublishes
-- it in the same statement: it is gone from the public pages at that moment, pictures included.
--
-- Pictures are kept in the table as base64 text, like a visit's pictures and within the same kind of
-- ceilings (routes/gallery.ts): few items, each small.

CREATE TABLE IF NOT EXISTS gallery_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 600),
  -- The picture of the result, and optionally the one from before.
  after_type TEXT NOT NULL CHECK (after_type IN ('image/jpeg', 'image/png', 'image/webp')),
  after_base64 TEXT NOT NULL,
  before_type TEXT CHECK (before_type IS NULL OR before_type IN ('image/jpeg', 'image/png', 'image/webp')),
  before_base64 TEXT,
  basis TEXT NOT NULL CHECK (basis IN ('illustrative', 'patient')),
  consent_given_on DATE,
  consent_reference TEXT CHECK (consent_reference IS NULL OR char_length(consent_reference) <= 200),
  consent_recorded_by INTEGER REFERENCES users(id),
  consent_revoked_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((before_type IS NULL) = (before_base64 IS NULL)),
  -- A patient's picture always has its consent on record, from the first moment it is stored.
  CHECK (basis <> 'patient' OR (consent_given_on IS NOT NULL AND consent_reference IS NOT NULL AND consent_recorded_by IS NOT NULL)),
  -- What was taken back is not shown.
  CHECK (status <> 'published' OR consent_revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS gallery_items_clinic_idx ON gallery_items (clinic_id, status);
ALTER TABLE gallery_items ENABLE ROW LEVEL SECURITY;
