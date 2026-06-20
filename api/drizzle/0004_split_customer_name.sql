ALTER TABLE "customers" ADD COLUMN "first_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN "name";
