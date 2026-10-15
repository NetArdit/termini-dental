-- Termini Dental, migration 014: what a patient sees of a dentist on the public pages: a professional title
-- ("Specialist i Endodoncisë") and a portrait.
--
-- The portrait is a small picture of the person, kept in the row as base64 text like the other pictures
-- (routes/clinic.ts limits it to 400 kB and checks the whole file). It is shown only for staff who are active
-- and take bookings; a deactivated person's portrait is not served.

ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_type TEXT CHECK (photo_type IS NULL OR photo_type IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_base64 TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_photo_pair;
ALTER TABLE users ADD CONSTRAINT users_photo_pair CHECK ((photo_type IS NULL) = (photo_base64 IS NULL));
