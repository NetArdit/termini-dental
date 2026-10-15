-- Termini Dental, migration 012: what patients say about the dentist who treated them.
--
-- The owner's rule: each dentist has reviews, with stars and an optional comment. Three things keep them
-- honest:
--   - a review belongs to one appointment, and there is at most one per appointment (UNIQUE), so only
--     somebody who really was a patient can write one, and once per visit;
--   - it is written through the patient's own private link, after the visit was completed;
--   - it appears on the public pages only after the clinic's administrator has looked at it ('published').
--     A comment is free text from the public: it is not shown before somebody has read it. The administrator
--     can also hide one again. Neither changes the stars or the words: a review is never edited.
-- The public pages show no patient's name beside a review.

CREATE TABLE IF NOT EXISTS dentist_reviews (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  dentist_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 600),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'hidden')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  moderated_by INTEGER REFERENCES users(id),
  moderated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS dentist_reviews_dentist_idx ON dentist_reviews (dentist_id, status);
ALTER TABLE dentist_reviews ENABLE ROW LEVEL SECURITY;
