CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"gateway_ref" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_provider_gateway_ref_unique" UNIQUE("provider","gateway_ref"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0),
	CONSTRAINT "refunds_currency_supported" CHECK ("refunds"."currency" in ('USD')),
	CONSTRAINT "refunds_status_valid" CHECK ("refunds"."status" in ('manual_pending', 'manual_confirmed', 'cancelled')),
	CONSTRAINT "refunds_confirmation_evidence_valid" CHECK (("refunds"."status" = 'manual_confirmed' and "refunds"."gateway_ref" is not null and "refunds"."confirmed_by" is not null and "refunds"."confirmed_at" is not null) or ("refunds"."status" <> 'manual_confirmed' and "refunds"."gateway_ref" is null and "refunds"."confirmed_by" is null and "refunds"."confirmed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_booking_id_idx" ON "refunds" USING btree ("booking_id");