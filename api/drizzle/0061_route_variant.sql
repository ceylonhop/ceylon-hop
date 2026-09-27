-- Customer route choice (spec docs/superpowers/specs/2026-09-26-customer-route-choice-design.md §4.2).
-- The road the customer paid for, so ops can brief the driver. Additive, nullable, no backfill:
-- null means the customer never chose, which is the expressway (today's behaviour). A nullable
-- ADD COLUMN takes no rewrite and no long lock on Postgres 11+.
-- Must be released AFTER 0059_booking_customer_notes (PR #837): drizzle skips a migration older than the last applied.
ALTER TABLE "transfer_request" ADD COLUMN IF NOT EXISTS "route_variant" text;
--> statement-breakpoint
ALTER TABLE "trip_request" ADD COLUMN IF NOT EXISTS "route_variants" text[];
