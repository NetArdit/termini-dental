-- Termini Dental, migration 011: pictures that belong to a visit (an X-ray, a photograph of the work).
--
-- The owner's rule: the dentist adds pictures to the report of a visit, and sees them again at the patient's
-- later visits. A picture belongs to one appointment and, through it, to one patient; it goes when the
-- appointment goes. It is a clinical record: who may see it is decided exactly as for the report itself, by
-- the same rules, in the same place (routes/staff.ts). It is never served to anybody who is not signed in.
--
-- The picture is kept in the database itself (as base64 text), not in a file store: it is then covered by
-- the same access rules, the same backup and the same deletion as the rest of the patient's record, with
-- nothing to keep in step. The price is room: text in a table is the dearest place to keep a picture. So
-- the page makes a picture small before sending it (the long side at most 1600 pixels), and the server
-- refuses more than 1 MB each, more than six for one visit and more than 120 MB for the whole clinic
-- (routes/staff.ts). That is enough to show the feature and to work with a few hundred pictures; a clinic
-- that keeps every patient's X-rays for years needs a file store, which is a decision of its own.

CREATE TABLE IF NOT EXISTS visit_images (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  -- What it is: an X-ray, or a photograph.
  kind TEXT NOT NULL CHECK (kind IN ('xray', 'photo')),
  caption TEXT,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  data_base64 TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visit_images_appointment_idx ON visit_images (appointment_id);
ALTER TABLE visit_images ENABLE ROW LEVEL SECURITY;
