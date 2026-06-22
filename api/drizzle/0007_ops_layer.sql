CREATE TABLE "coordinators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"whatsapp" text NOT NULL,
	"regions" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ride_ops" (
	"booking_id" uuid PRIMARY KEY NOT NULL,
	"coordinator_id" uuid,
	"fulfilment_status" text DEFAULT 'unassigned' NOT NULL,
	"vehicle_photo_received" boolean DEFAULT false NOT NULL,
	"customer_updated" boolean DEFAULT false NOT NULL,
	"ops_notes" text,
	"assigned_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"vehicle_confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ride_ops" ADD CONSTRAINT "ride_ops_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_ops" ADD CONSTRAINT "ride_ops_coordinator_id_coordinators_id_fk" FOREIGN KEY ("coordinator_id") REFERENCES "public"."coordinators"("id") ON DELETE no action ON UPDATE no action;