-- Partner experiences on the pay-link confirmation (owner, 2026-10-15, option B). Hand-written: drizzle-kit generate needs a TTY.
-- A "Request info" tap on a paid pay link is recorded on the booking with a new source, 'pay_page'. The CHECK from
-- 0065 is dropped and re-added with the third value; no column, no row is touched. Re-adding validates the existing
-- rows, which all carry 'booking_page' or 'quote_page' — the old constraint guaranteed it.
ALTER TABLE "experience_interests" DROP CONSTRAINT "experience_interests_source_valid";
--> statement-breakpoint
ALTER TABLE "experience_interests" ADD CONSTRAINT "experience_interests_source_valid" CHECK ("source" in ('booking_page', 'quote_page', 'pay_page'));
