ALTER TABLE "quotes" ADD COLUMN "rate_card_json" jsonb;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "rate_locked_until" timestamp with time zone;
