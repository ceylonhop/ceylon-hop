ALTER TABLE "quotes" ADD COLUMN "assigned_to" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "updated_by" text;