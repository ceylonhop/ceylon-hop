-- Customer route choice (spec docs/superpowers/specs/2026-09-26-customer-route-choice-design.md §4.2).
-- The road the customer paid for, so ops can brief the driver. Additive, nullable, no backfill:
-- null means the customer never chose, which is the expressway (today's behaviour). A nullable
-- ADD COLUMN takes no rewrite and no long lock on Postgres 11+.
-- RELEASE ORDER IS HARD: this migration (when 1790812800000) must release AFTER
-- 0059_booking_customer_notes (#837, when 1790640000000) and 0060_customer_communications (#850,
-- when 1790726400000). drizzle applies only migrations newer than the last one applied, so if
-- this reached a database first, those two would be skipped there forever. Renumbered from 0060
-- on 2026-09-27 when #850 took that number.
ALTER TABLE "transfer_request" ADD COLUMN IF NOT EXISTS "route_variant" text;
--> statement-breakpoint
ALTER TABLE "trip_request" ADD COLUMN IF NOT EXISTS "route_variants" text[];
