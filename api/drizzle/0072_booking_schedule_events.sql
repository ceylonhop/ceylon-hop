-- Dateless booking capture, Phase 1 (spec 2026-10-17 §4). Hand-written: drizzle-kit generate needs a TTY.
-- Every pickup date/time change made AFTER booking — from → to, staff or customer, who, when —
-- because the change overwrites transfer_request/booking_legs in place. Also widens the
-- customer_communications kind check for the 'schedule_set' email. Changes no rows. Rollback: drop
-- the table; restoring the old kind list first needs any 'schedule_set' rows deleted, or the check fails.
CREATE TABLE "booking_schedule_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_date" text,
	"from_time" text,
	"to_date" text NOT NULL,
	"to_time" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_schedule_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id"),
	CONSTRAINT "booking_schedule_events_actor_type_valid" CHECK ("actor_type" in ('staff', 'customer'))
);
--> statement-breakpoint
CREATE INDEX "booking_schedule_events_booking_created_idx" ON "booking_schedule_events" USING btree ("booking_id","created_at");
--> statement-breakpoint
-- Migration 0048 protected every table that existed then; later tables protect themselves.
ALTER TABLE "booking_schedule_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received', 'schedule_set'));
