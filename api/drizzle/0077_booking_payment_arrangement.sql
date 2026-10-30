-- 0077 — Pay on the day (owner, 2026-10-29). How the customer will pay when it isn't "now, by card".
--
-- bookings.payment_arrangement: null = the normal flow (every existing row, untouched).
-- 'on_the_day' = USD cash to the driver at the first pickup. It is the ONLY thing that lets a booking
-- go payment_pending → confirmed with no payment (domain/status.ts), so a confirmed trip no longer
-- implies money was taken: money facts come from the payments ledger (domain/balance.ts).
--
-- customer_communications: adds the 'pay_on_day_confirmed' email kind (the "You're confirmed — pay
-- on the day" letter). Every existing kind is kept verbatim (list as of 0073).
--
-- Hand-written: drizzle-kit generate needs a TTY. Additive only — no rows change.
-- Release: merging to main applies it on staging boot; prod on the main → production promote.
-- Rollback: ALTER TABLE "bookings" DROP CONSTRAINT bookings_payment_arrangement_valid, DROP COLUMN
-- payment_arrangement; restore 0073's customer_communications_kind_valid list.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "payment_arrangement" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_payment_arrangement_valid') THEN
    ALTER TABLE "bookings" ADD CONSTRAINT bookings_payment_arrangement_valid
      CHECK (payment_arrangement IS NULL OR payment_arrangement IN ('on_the_day'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received', 'schedule_set', 'details_reminder_1', 'details_reminder_2', 'pay_on_day_confirmed'));
