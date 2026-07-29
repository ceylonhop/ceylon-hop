-- SH7: preserve legacy succeeded payments without fabricating PayHere evidence.
-- updated_at is the best application-owned timestamp available; the source makes its
-- provenance explicit and prevents callers from treating it as a gateway timestamp.
UPDATE "payments"
SET
  settled_at = coalesce(settled_at, updated_at),
  settlement_source = 'legacy_backfill'
WHERE status = 'succeeded'
  AND (settled_at IS NULL OR settlement_source IS NULL);--> statement-breakpoint

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_total_nonnegative" CHECK ("bookings"."total" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_amount_due_now_valid" CHECK ("bookings"."amount_due_now" is null or ("bookings"."amount_due_now" >= 0 and "bookings"."amount_due_now" <= "bookings"."total")) NOT VALID;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_currency_supported" CHECK ("bookings"."currency" in ('USD')) NOT VALID;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_mode_valid" CHECK ("bookings"."mode" in ('single', 'trip', 'shared')) NOT VALID;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_status_valid" CHECK ("bookings"."status" in ('draft', 'payment_pending', 'awaiting_details', 'paid', 'confirmed', 'in_progress', 'completed', 'cancelled', 'refunded', 'no_show')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_supported" CHECK ("payments"."currency" in ('USD')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_supported" CHECK ("payments"."provider" in ('payhere', 'fake')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_valid" CHECK ("payments"."status" in ('pending', 'succeeded', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_succeeded_settled_at_required" CHECK ("payments"."status" <> 'succeeded' or "payments"."settled_at" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_succeeded_settlement_source_required" CHECK ("payments"."status" <> 'succeeded' or "payments"."settlement_source" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "corridor" ADD CONSTRAINT "corridor_seat_price_positive" CHECK ("corridor"."seat_price" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "corridor" ADD CONSTRAINT "corridor_seat_capacity_positive" CHECK ("corridor"."seat_capacity" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "shared_departure" ADD CONSTRAINT "shared_departure_seats_total_positive" CHECK ("shared_departure"."seats_total" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "shared_departure" ADD CONSTRAINT "shared_departure_seats_booked_valid" CHECK ("shared_departure"."seats_booked" >= 0 and "shared_departure"."seats_booked" <= "shared_departure"."seats_total") NOT VALID;--> statement-breakpoint

ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_total_nonnegative";--> statement-breakpoint
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_amount_due_now_valid";--> statement-breakpoint
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_currency_supported";--> statement-breakpoint
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_mode_valid";--> statement-breakpoint
ALTER TABLE "bookings" VALIDATE CONSTRAINT "bookings_status_valid";--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_amount_positive";--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_currency_supported";--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_provider_supported";--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_status_valid";--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_succeeded_settled_at_required";--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_succeeded_settlement_source_required";--> statement-breakpoint
ALTER TABLE "corridor" VALIDATE CONSTRAINT "corridor_seat_price_positive";--> statement-breakpoint
ALTER TABLE "corridor" VALIDATE CONSTRAINT "corridor_seat_capacity_positive";--> statement-breakpoint
ALTER TABLE "shared_departure" VALIDATE CONSTRAINT "shared_departure_seats_total_positive";--> statement-breakpoint
ALTER TABLE "shared_departure" VALIDATE CONSTRAINT "shared_departure_seats_booked_valid";
