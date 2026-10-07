-- Partner experiences (spec 2026-10-06). Hand-written: drizzle-kit generate needs a TTY.
CREATE TABLE "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"partner_name" text NOT NULL,
	"area_label" text NOT NULL,
	"summary" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"price_unit" text NOT NULL,
	"duration_text" text,
	"open_weekdays" integer[] DEFAULT '{0,1,2,3,4,5,6}' NOT NULL,
	"start_times" text[] DEFAULT '{}' NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"radius_km" double precision DEFAULT 5 NOT NULL,
	"photos" text[] DEFAULT '{}' NOT NULL,
	"partner_contact" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiences_slug_unique" UNIQUE("slug"),
	CONSTRAINT "experiences_price_nonnegative" CHECK ("price_cents" >= 0),
	CONSTRAINT "experiences_currency_supported" CHECK ("currency" in ('USD')),
	CONSTRAINT "experiences_price_unit_valid" CHECK ("price_unit" in ('per_person', 'per_group')),
	CONSTRAINT "experiences_radius_valid" CHECK ("radius_km" > 0 and "radius_km" <= 60)
);
--> statement-breakpoint
CREATE TABLE "experience_interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL REFERENCES "experiences"("id"),
	"booking_id" uuid REFERENCES "bookings"("id"),
	"quote_id" uuid REFERENCES "quotes"("id"),
	"source" text NOT NULL,
	"name_snapshot" text NOT NULL,
	"price_cents_snapshot" integer NOT NULL,
	"price_unit_snapshot" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"payment_ref" text,
	"amount_paid_cents" integer,
	"amount_paid_currency" text,
	"ops_note" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_interests_has_owner" CHECK ("booking_id" is not null or "quote_id" is not null),
	CONSTRAINT "experience_interests_source_valid" CHECK ("source" in ('booking_page', 'quote_page')),
	CONSTRAINT "experience_interests_status_valid" CHECK ("status" in ('new', 'contacted', 'link_sent', 'paid', 'declined')),
	CONSTRAINT "experience_interests_paid_has_ref" CHECK ("status" <> 'paid' or "payment_ref" is not null),
	CONSTRAINT "experience_interests_amount_valid" CHECK ("amount_paid_cents" is null or "amount_paid_cents" >= 0),
	CONSTRAINT "experience_interests_amount_currency_valid" CHECK ("amount_paid_currency" is null or "amount_paid_currency" in ('USD', 'LKR')),
	CONSTRAINT "experience_interests_ref_length" CHECK ("payment_ref" is null or char_length("payment_ref") <= 100),
	CONSTRAINT "experience_interests_note_length" CHECK ("ops_note" is null or char_length("ops_note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "experience_interests_booking_uq" ON "experience_interests" ("experience_id", "booking_id") WHERE "booking_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "experience_interests_quote_uq" ON "experience_interests" ("experience_id", "quote_id") WHERE "quote_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "experience_interests_status_idx" ON "experience_interests" ("status");
