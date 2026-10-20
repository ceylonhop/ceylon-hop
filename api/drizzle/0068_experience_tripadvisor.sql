-- Live Tripadvisor ratings (spec 2026-10-06 D22). Hand-written: drizzle-kit generate needs a TTY.
-- Tripadvisor's terms allow storing only the listing's location id; the rating and review count are fetched
-- live on every view and never kept. A nullable ADD COLUMN with no default: no table rewrite, existing rows
-- untouched. The CHECK keeps a pasted URL (or anything else) out of a column that is spliced into an API path.
ALTER TABLE "experiences" ADD COLUMN "tripadvisor_location_id" text;
--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_tripadvisor_location_id_digits" CHECK ("tripadvisor_location_id" is null or "tripadvisor_location_id" ~ '^[0-9]{1,15}$');
