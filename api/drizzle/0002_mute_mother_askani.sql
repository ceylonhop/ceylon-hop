CREATE TABLE "trip_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"service_type" text NOT NULL,
	"pax" integer NOT NULL,
	"vehicle_type" text NOT NULL,
	"stops" text[] NOT NULL,
	"nights" integer[] NOT NULL,
	"dates" text[],
	CONSTRAINT "trip_request_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "mode" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "trip_request" ADD CONSTRAINT "trip_request_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;