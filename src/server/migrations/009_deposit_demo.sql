-- Termini Dental, migration 009: the 15 euro deposit of an online booking, as a DEMONSTRATION.
--
-- The owner's rule: a patient who books online pays 15 euro by card; if they come, the amount is taken off
-- their bill; if they do not, the clinic keeps it. No payment provider is connected yet, so what exists today
-- is the demonstration of that step: the booking page shows a card form, nothing is charged, and no card
-- data leaves the patient's browser. What an appointment records is only:
--
--   deposit_mode          'demo' (later: a real mode, when a provider is connected), or NULL: no deposit
--   deposit_amount_minor  the amount in cents, e.g. 1500
--   deposit_currency      'EUR'
--   bill_credit_minor     what the dentist takes off the bill at the visit, in cents
--
-- There is no column for a card number, an expiry date, a security code, a cardholder's name or anything
-- worked out from them, here or anywhere else in this database, and the booking route refuses a request
-- that carries such a field.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_mode TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_amount_minor INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_currency TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS bill_credit_minor INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_deposit_check') THEN
    -- Written so that a missing value can never slip through: a CHECK passes when its condition is unknown,
    -- and a comparison with NULL is unknown. COALESCE turns "unknown" into "no".
    ALTER TABLE appointments ADD CONSTRAINT appointments_deposit_check CHECK (
      COALESCE(
        (deposit_mode IS NULL AND deposit_amount_minor IS NULL AND deposit_currency IS NULL AND bill_credit_minor = 0)
        OR
        (deposit_mode = 'demo' AND deposit_amount_minor > 0 AND deposit_currency = 'EUR' AND bill_credit_minor BETWEEN 0 AND deposit_amount_minor),
        FALSE
      )
    );
  END IF;
END $$;
