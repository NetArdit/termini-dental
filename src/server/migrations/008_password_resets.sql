-- Termini Dental, migration 008: a member of staff who forgot their password can set a new one.
--
-- They ask with their email address and receive a link that works once, for half an hour. Only a hash of
-- the link's secret is kept here, as for sessions and for patients' links: whoever reads this table, or a
-- copy of it, cannot use it to get into an account. A new request ends the earlier links of that person;
-- using one ends them all and signs the person out everywhere.
-- Rows are of no use once used or expired, and are not part of a backup.

CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the secret in the link (hex).
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
