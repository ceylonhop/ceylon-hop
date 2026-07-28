ALTER TABLE "quotes" ADD COLUMN "intent_json" jsonb;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "intent_fingerprint" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "access_token_digest" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_converted_booking_id_unique" UNIQUE("converted_booking_id");