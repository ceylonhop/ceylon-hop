-- Dateless booking capture, Phase 2 (plan 2026-10-18). Hand-written: drizzle-kit generate needs a TTY.
-- The two "we still need your pickup date/time" reminders get their own kinds, so each send has its
-- own tracking key (`bookingId:kind`). Widens the check only; changes no rows. Rollback: restore the
-- previous list after deleting any rows of these two kinds.
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received', 'schedule_set', 'details_reminder_1', 'details_reminder_2'));
