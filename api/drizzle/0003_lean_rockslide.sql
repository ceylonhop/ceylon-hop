CREATE TABLE "corridor" (
	"id" text PRIMARY KEY NOT NULL,
	"from_place" text NOT NULL,
	"to_place" text NOT NULL,
	"seat_price" integer NOT NULL,
	"seat_capacity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_departure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corridor_id" text NOT NULL,
	"date" text NOT NULL,
	"time" text NOT NULL,
	"seats_total" integer NOT NULL,
	"seats_booked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shared_departure_corridor_id_date_time_unique" UNIQUE("corridor_id","date","time")
);
--> statement-breakpoint
CREATE TABLE "shared_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"corridor_id" text NOT NULL,
	"date" text NOT NULL,
	"time" text NOT NULL,
	"seats" integer NOT NULL,
	CONSTRAINT "shared_request_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
ALTER TABLE "shared_departure" ADD CONSTRAINT "shared_departure_corridor_id_corridor_id_fk" FOREIGN KEY ("corridor_id") REFERENCES "public"."corridor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_request" ADD CONSTRAINT "shared_request_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_request" ADD CONSTRAINT "shared_request_corridor_id_corridor_id_fk" FOREIGN KEY ("corridor_id") REFERENCES "public"."corridor"("id") ON DELETE no action ON UPDATE no action;