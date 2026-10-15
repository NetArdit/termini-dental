-- Termini Dental, migration 005: the patient's private link is no longer written down anywhere (audit H1).
--
-- The link in a confirmation opens the appointment and can cancel it, for whoever holds it. The appointment
-- itself kept only a hash of it, but the text of every message was kept whole in email_log, link included:
-- shown to staff, copied into every backup. Whoever read the database or a backup held every patient's link.
--
-- From now on a stored message has a placeholder where the link goes, and the link is put in only at the
-- moment the message is handed to the mail server:
--   - on the first attempt, from memory (the request that made the booking has it);
--   - on any later attempt (a retry, "send again"), a NEW link is made for that message and only its hash is
--     kept, added to mail_token_hashes. Every link that was ever put into a mail keeps working, beside the
--     one shown on the patient's screen after booking (token_hash): a mail that was recorded as refused may
--     have arrived all the same. A cancellation ends all of them at once.
-- No secret key is needed for this, and none is kept.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS mail_token_hashes TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS appointments_mail_tokens_idx ON appointments USING gin (mail_token_hashes);

-- Messages already stored: the link is taken out of their text. One that still has to be sent gets a new
-- link when it is. A link that was already delivered keeps working: its hash is on the appointment.
UPDATE email_log
   SET body = regexp_replace(body, '(/termin#)[A-Za-z0-9_-]{20,}', '\1{{token}}', 'g')
 WHERE body ~ '/termin#[A-Za-z0-9_-]{20,}';
