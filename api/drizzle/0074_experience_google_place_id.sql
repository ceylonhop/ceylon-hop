-- "Find the business on Google" (2026-10-18). Hand-written: drizzle-kit generate needs a TTY.
-- Keeps the Google place id an experience was filled from, so its pin can be refreshed later; Google's
-- terms let us keep place ids indefinitely. A nullable ADD COLUMN with no default: no table rewrite,
-- existing rows untouched. The CHECK keeps a pasted URL (or anything else) out of a column that is spliced
-- into a Places API path.
-- 255, not more: Postgres caps a regex repetition count at 255 and refuses the whole CHECK otherwise. Rollback: ALTER TABLE "experiences" DROP COLUMN "google_place_id".
ALTER TABLE "experiences" ADD COLUMN "google_place_id" text;
--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_google_place_id_shape" CHECK ("google_place_id" is null or "google_place_id" ~ '^[A-Za-z0-9_-]{10,255}$');
