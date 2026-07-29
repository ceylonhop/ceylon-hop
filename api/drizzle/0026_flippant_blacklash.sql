ALTER TABLE "bookings" ADD COLUMN "subtotal" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "discount_total" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "pricing_snapshot_json" jsonb;