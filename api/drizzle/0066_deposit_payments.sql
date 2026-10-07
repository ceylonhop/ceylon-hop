-- Deposits, ops first (spec docs/superpowers/specs/2026-10-07-deposits-ops-first-design.md §4).
-- A booking can now hold two payments: a deposit and, later, its balance. `purpose` says which.
-- Every existing row is a full payment, which the constant default records without rewriting the
-- table (Postgres >= 11 stores a constant default in the catalogue).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'full' NOT NULL;
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_valid" CHECK ("purpose" in ('full', 'deposit', 'balance'));

-- The deposit a deposit pay link charges, frozen at mint like sold_cents freezes a partial link.
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "pay_link_deposit_cents" integer;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_pay_link_deposit_cents_positive" CHECK ("pay_link_deposit_cents" is null or "pay_link_deposit_cents" > 0);

-- The "you're fully paid" receipt (spec §6).
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received'));
