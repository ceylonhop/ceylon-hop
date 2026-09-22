-- The luggage a shared seat was charged for (audit 2026-09-22, finding 1).
--
-- priceShared() bills $10 for every bag beyond one per seat, but the booking's stored input
-- had no `bags` field at all. The surcharge landed in the total with nothing anywhere to
-- explain it -- not to the customer reading their confirmation, not to ops loading the
-- vehicle, and not to anyone reconstructing a refund dispute months later.
--
-- Same shape as the leg columns in 0051: the customer chose it, we charged for it, we never
-- wrote it down, and then every display had to guess.
--
-- Additive and nullable. NULL means "this row predates the column", which is honestly
-- different from 0 ("no bags were declared") -- and the two must not be conflated, because a
-- historical row's true bag count is not recoverable. Unlike 0051 there is nothing to
-- backfill from: the bag count exists only in the total, and the total cannot be decomposed
-- without knowing the seat price at the time of sale.
ALTER TABLE shared_request ADD COLUMN IF NOT EXISTS bags integer;

-- Guard the range the application already enforces, so a bad write fails loudly here rather
-- than becoming a negative surcharge later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shared_request_bags_non_negative'
  ) THEN
    ALTER TABLE shared_request
      ADD CONSTRAINT shared_request_bags_non_negative CHECK (bags IS NULL OR bags >= 0);
  END IF;
END $$;
