-- Termini Dental, migration 010: what a service costs, as the clinic chooses to say it.
--
-- The owner wants prices on the public pages. A dental price depends on the tooth and the case, so what is
-- stored is the price a service STARTS from ("nga 20 €"), in cents, and it is optional: a service the clinic
-- has not priced shows no price at all, rather than a made-up one. The administrator sets it in Settings.

ALTER TABLE services ADD COLUMN IF NOT EXISTS price_from_minor INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_price_from_check') THEN
    ALTER TABLE services ADD CONSTRAINT services_price_from_check CHECK (price_from_minor IS NULL OR price_from_minor BETWEEN 0 AND 10000000);
  END IF;
END $$;
