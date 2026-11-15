-- 0079 — Add-ons after booking (owner, 2026-11-14; spec 2026-11-14-post-booking-add-ons-design.md §5).
--
-- booking_add_on_requests: what ops sends the customer after the trip is booked. One request is one
-- payment. `seq` numbers a booking's requests 1, 2, … and names the order id (REF-A<seq>).
-- booking_add_ons: the request's lines — one rate-card add-on on one stored leg (booking_legs.id),
-- label and price frozen when it was sent. `code` is deliberately not CHECKed: the rate card owns
-- the list. Neither table changes what the booking itself cost.
--
-- payments: adds the 'add_on' purpose. Every existing purpose is kept verbatim (list as of 0066).
-- customer_communications: adds the 'add_on_request' and 'add_on_paid' email kinds. Every existing
-- kind is kept verbatim (list as of 0077).
--
-- Hand-written: drizzle-kit generate needs a TTY. Additive only — no rows change, and nothing reads
-- or writes the new tables or values until the later add-on PRs.
-- Release: merging to main applies it on staging boot; prod on the main → production promote.
-- Rollback: DROP TABLE "booking_add_ons"; DROP TABLE "booking_add_on_requests"; then restore 0066's
-- payments_purpose_valid list and 0077's customer_communications_kind_valid list. Restoring a list
-- first needs any rows using the new values deleted, or the check fails.
CREATE TABLE IF NOT EXISTS "booking_add_on_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"status" text NOT NULL,
	"total_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"rate_card_version" text NOT NULL,
	"payment_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "booking_add_on_requests_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id"),
	CONSTRAINT "booking_add_on_requests_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id"),
	CONSTRAINT "booking_add_on_requests_booking_seq_unique" UNIQUE("booking_id","seq"),
	CONSTRAINT "booking_add_on_requests_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "booking_add_on_requests_status_valid" CHECK ("status" in ('open', 'paid', 'cancelled')),
	CONSTRAINT "booking_add_on_requests_total_positive" CHECK ("total_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "booking_add_ons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"leg_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "booking_add_ons_request_id_booking_add_on_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."booking_add_on_requests"("id"),
	CONSTRAINT "booking_add_ons_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id"),
	CONSTRAINT "booking_add_ons_leg_id_booking_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."booking_legs"("id"),
	CONSTRAINT "booking_add_ons_amount_positive" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_add_ons_booking_idx" ON "booking_add_ons" USING btree ("booking_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_add_ons_request_idx" ON "booking_add_ons" USING btree ("request_id");
--> statement-breakpoint
-- Migration 0048 protected every table that existed then; later tables protect themselves.
ALTER TABLE "booking_add_on_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "booking_add_ons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_purpose_valid";
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_purpose_valid" CHECK ("purpose" in ('full', 'deposit', 'balance', 'add_on'));
--> statement-breakpoint
ALTER TABLE "customer_communications" DROP CONSTRAINT IF EXISTS "customer_communications_kind_valid";
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received', 'schedule_set', 'details_reminder_1', 'details_reminder_2', 'pay_on_day_confirmed', 'add_on_request', 'add_on_paid'));
