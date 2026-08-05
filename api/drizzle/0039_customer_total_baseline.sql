-- Price-drift indicator (spec 2026-08-05 §9). The quote TOTAL as of the last customer-facing
-- moment, so the ops builder can show "Sent at $109.00 - now $99.00".
--
-- Deliberately the quote total, NOT the amount charged: a partial-leg link charges less than the
-- total by design, so storing the charged amount would show permanent drift on every quote that
-- ever had one. The charged amount already lives in quotes.sold_cents.
ALTER TABLE "quotes" ADD COLUMN "customer_total_cents" integer;
ALTER TABLE "quotes" ADD COLUMN "customer_total_at" timestamptz;
ALTER TABLE "quotes" ADD COLUMN "customer_total_via" text;
