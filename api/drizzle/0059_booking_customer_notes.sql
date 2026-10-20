-- The customer's own note from the booking page (2026-09-27). The details step has always asked
-- "Anything we should know?" (hotel name, dietary needs, surf gear), but nothing read the box:
-- whatever a customer wrote was dropped in the browser, so ops never saw it
-- (docs/e2e-review-2026-07-11.md, lane cust-booking).
--
-- On the BOOKING, not transfer_request: the page asks it of single transfers, trips and shared
-- seats alike, the same way billing and the terms acceptance are booking-level.
-- Customer-authored, so it is distinct from ride_ops.ops_notes, which only ops write.
--
-- Additive and nullable. NULL means no note, or a row that predates the column.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "customer_notes" text;

-- The API already refuses more than 1,000 characters; this makes the database refuse it too,
-- so no other writer can store an unbounded blob in a column every ops screen and email reads.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_customer_notes_length'
  ) THEN
    ALTER TABLE "bookings"
      ADD CONSTRAINT bookings_customer_notes_length
      CHECK (customer_notes IS NULL OR char_length(customer_notes) <= 1000);
  END IF;
END $$;
