-- 0080 — Per-leg ops steps (owner, 2026-11-19; spec 2026-11-19-per-leg-ops-status-design.md).
--
-- ride_ops_legs: the ops fulfilment status of ONE driven leg of a private multi-stop trip, keyed
-- by the stored leg (booking_legs.id). Until now a trip had a single status on ride_ops, so marking
-- the first leg completed closed the whole booking and the later legs were never handled.
-- A leg with no row has not been touched and counts as 'paid'. 'no_show' is deliberately absent
-- from the allowed values: it closes the whole booking and stays on ride_ops.
--
-- Row-level security is switched on with no policy, like every other table: the API connects as
-- the owner, and nothing else may read it.
--
-- Hand-written: drizzle-kit generate needs a TTY. Additive only — one new table, no existing row
-- or table changes, and nothing reads or writes it until the later per-leg PRs.
-- Release: merging to main applies it on staging boot; prod on the main → production promote.
-- Rollback: DROP TABLE "ride_ops_legs";
CREATE TABLE IF NOT EXISTS "ride_ops_legs" (
	"leg_id" uuid PRIMARY KEY NOT NULL,
	"fulfilment_status" text DEFAULT 'paid' NOT NULL,
	"vehicle_photo_received" boolean DEFAULT false NOT NULL,
	"customer_updated" boolean DEFAULT false NOT NULL,
	"vehicle_confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ride_ops_legs_leg_id_booking_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."booking_legs"("id"),
	CONSTRAINT "ride_ops_legs_status_valid" CHECK ("fulfilment_status" in ('paid', 'vehicle_confirmed', 'pickup_confirmed', 'on_trip', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "ride_ops_legs" ENABLE ROW LEVEL SECURITY;
