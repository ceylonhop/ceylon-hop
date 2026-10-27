-- Ops date/time changes (requirements 2026-10-26, option A). Hand-written: drizzle-kit generate needs a TTY.
-- booking_schedule_events gains the reason and note ops give for a change, and the leg a multi-stop
-- change moved (null = the whole booking, as every row so far). ride_ops gains the "Driver told?" task:
-- set when a date moves on a job a driver already has, cleared when ops ticks it. Nullable ADD COLUMNs
-- with no default: no table rewrite, existing rows untouched. Rollback: drop the constraints, then the
-- four columns.
ALTER TABLE "booking_schedule_events" ADD COLUMN "reason" text;
--> statement-breakpoint
ALTER TABLE "booking_schedule_events" ADD COLUMN "note" text;
--> statement-breakpoint
ALTER TABLE "booking_schedule_events" ADD COLUMN "leg_id" uuid;
--> statement-breakpoint
ALTER TABLE "booking_schedule_events" ADD CONSTRAINT "booking_schedule_events_leg_id_booking_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."booking_legs"("id");
--> statement-breakpoint
ALTER TABLE "booking_schedule_events" ADD CONSTRAINT "booking_schedule_events_reason_valid" CHECK ("reason" is null or "reason" in ('customer_changed_plans', 'customer_entered_wrong', 'flight_changed', 'our_mistake', 'other'));
--> statement-breakpoint
ALTER TABLE "ride_ops" ADD COLUMN "driver_update_pending_since" timestamp with time zone;
