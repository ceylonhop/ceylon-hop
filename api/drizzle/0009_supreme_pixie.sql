CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"channel" text DEFAULT 'ops' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"lost_reason" text,
	"product" text NOT NULL,
	"vehicle" text,
	"customer_name" text,
	"customer_contact" text,
	"total_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"rate_card_version" text NOT NULL,
	"margin_cents" integer,
	"request_json" jsonb NOT NULL,
	"result_json" jsonb NOT NULL,
	"converted_booking_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "quotes_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_converted_booking_id_bookings_id_fk" FOREIGN KEY ("converted_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;