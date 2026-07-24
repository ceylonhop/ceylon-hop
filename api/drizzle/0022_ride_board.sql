CREATE TABLE "ride_list_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"sub" text NOT NULL,
	"first_name" text NOT NULL,
	"country" text NOT NULL,
	"email" text NOT NULL,
	"photo_url" text,
	"preferred_time" text,
	"seats" integer DEFAULT 1 NOT NULL,
	"preapproval_ref" text,
	"status" text DEFAULT 'held' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ride_list_member_list_id_sub_unique" UNIQUE("list_id","sub")
);
--> statement-breakpoint
CREATE TABLE "ride_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"corridor_id" text NOT NULL,
	"from_place" text NOT NULL,
	"to_place" text NOT NULL,
	"date" text NOT NULL,
	"slot" text NOT NULL,
	"locked_time" text,
	"min_seats" integer NOT NULL,
	"capacity" integer NOT NULL,
	"seat_price" integer NOT NULL,
	"status" text DEFAULT 'gathering' NOT NULL,
	"note" text,
	"cutoff_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ride_list_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "ride_list_member" ADD CONSTRAINT "ride_list_member_list_id_ride_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."ride_list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_list" ADD CONSTRAINT "ride_list_corridor_id_corridor_id_fk" FOREIGN KEY ("corridor_id") REFERENCES "public"."corridor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ride_list_member_list_idx" ON "ride_list_member" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "ride_list_status_idx" ON "ride_list" USING btree ("status");