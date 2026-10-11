-- Termini Dental, migration 003: the counters behind the limits on failed logins and on online bookings.
--
-- They used to live in the memory of the one server process. That stops meaning anything as soon as the
-- application runs as several short-lived instances (serverless functions): each instance would count for
-- itself and forget on every restart, and password guessing would go unchecked without anyone noticing.
-- One row per counted event. Whom an event belongs to is stored as a keyed hash, never as an email address
-- or a network address: this table says "this unknown party tried 8 times", not who they are.
-- Rows are of no use after their window (an hour at most) and are deleted as counting goes on.

CREATE TABLE IF NOT EXISTS rate_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- What is being limited: 'login' or 'booking'.
  bucket TEXT NOT NULL,
  -- HMAC-SHA256 of the bucket and the party (hex). Not reversible without the application's secret.
  key_hash TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_key_idx ON rate_events (bucket, key_hash, at);
CREATE INDEX IF NOT EXISTS rate_events_at_idx ON rate_events (at);
ALTER TABLE rate_events ENABLE ROW LEVEL SECURITY;
