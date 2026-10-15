-- Termini Dental, migration 004: an online booking that is sent twice is one booking.
--
-- A patient presses "Rezervo", the appointment is stored, and the answer is lost on the way back (a tunnel, a
-- phone that changes network). The page tries again. Without this table the second request was a new
-- booking: refused as "this time was just taken" although the patient holds it, or, with "any dentist",
-- stored a second time with another dentist.
--
-- The page now names each attempt with a key of its own making and sends it with every try. One row here
-- says: this key, with this content, became this appointment. The same key with the same content gets the
-- same answer back; the same key with other content is refused.
--
-- What is stored is as little as that needs. Neither the key nor the patient's private link is here: the key
-- is kept as a hash, and the link is worked out again from the key the page sends (see routes/public.ts), so
-- nobody who reads this table, or a copy of it, can open an appointment with it.
-- Rows are of use for as long as a page may still be retrying, and are deleted a day later.

CREATE TABLE IF NOT EXISTS booking_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  -- SHA-256 of the key (hex).
  key_hash TEXT NOT NULL,
  -- SHA-256 of what was asked for (hex): service, dentist, time, name, phone, email.
  request_hash TEXT NOT NULL,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, key_hash)
);
CREATE INDEX IF NOT EXISTS booking_requests_created_idx ON booking_requests (created_at);
ALTER TABLE booking_requests ENABLE ROW LEVEL SECURITY;
