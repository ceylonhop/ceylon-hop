ALTER TABLE "ride_list_member" ADD COLUMN "preapproval_order_id" text;--> statement-breakpoint
ALTER TABLE "ride_list_member" ADD COLUMN "preapproval_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ride_list_member" ADD CONSTRAINT "ride_list_member_preapproval_order_id_unique" UNIQUE("preapproval_order_id");
