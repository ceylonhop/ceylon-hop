-- Identify repeat customers without merging their rows (owner, 2026-08-02).
--
-- Every booking inserts a fresh `customers` row, so prod holds 10 rows for 5 actual people.
-- That undermines any repeat-guest view or customer count.
--
-- The obvious fix — dedupe by email and reuse the row — WOULD CORRUPT EXISTING BOOKINGS.
-- A booking has no traveller of its own: postgresBookingRepo.assemble() reads the name off
-- the linked customers row, and transfer_request/trip_request store places and dates but no
-- name. So merging two rows rewrites the traveller on whichever booking wrote first — the
-- driver meets the wrong name at arrivals, and the confirmation email is addressed to a
-- stranger.
--
-- So: LINK, don't merge. Each booking keeps its own row (an accurate snapshot of who was
-- travelling that time), and person_key groups them. Nothing existing changes value.
--
-- GENERATED ALWAYS: the key cannot drift from the email, and no application code path can
-- forget to set it. Postgres computes it for existing rows as part of this ALTER, so there is
-- no backfill step and nothing to run by hand.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS person_key text
  GENERATED ALWAYS AS (lower(btrim(email))) STORED;

CREATE INDEX IF NOT EXISTS customers_person_key_idx ON customers (person_key);
