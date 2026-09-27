-- Customer route choice (spec docs/superpowers/specs/2026-09-26-customer-route-choice-design.md §4.2).
-- The road the customer paid for, so ops can brief the driver. Additive, nullable, no backfill:
-- null means the customer never chose, which is the expressway (today's behaviour). A nullable
-- ADD COLUMN takes no rewrite and no long lock on Postgres 11+.
-- RELEASE ORDER IS HARD: 0059_booking_customer_notes (PR #837, when 1790640000000) must merge and
-- release BEFORE this migration (when 1790726400000). drizzle applies only migrations newer than
-- the last one applied, so if this reached a database first, 0059 would be skipped there forever.
-- If the order must flip, #837 must re-stamp its `when` above this one's before it merges.
ALTER TABLE "transfer_request" ADD COLUMN IF NOT EXISTS "route_variant" text;
--> statement-breakpoint
ALTER TABLE "trip_request" ADD COLUMN IF NOT EXISTS "route_variants" text[];
