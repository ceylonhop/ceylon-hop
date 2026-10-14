-- payments.booking_id is a foreign key, and Postgres never indexes those on its own. The ops
-- Bookings list, the watchdog, the pay link, refunds and the promo-use count all look payments up
-- by booking, so each one scanned the whole table. An index only: no rows or columns change.
--
-- Not CONCURRENTLY: the migrator runs inside a transaction, which CONCURRENTLY refuses. A plain
-- build blocks writes to payments while it runs, which for a table this size is milliseconds.
CREATE INDEX IF NOT EXISTS "payments_booking_id_idx" ON "payments" ("booking_id");
