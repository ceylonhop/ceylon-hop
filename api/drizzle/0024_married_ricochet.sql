CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_txn_id" text NOT NULL,
	"provider_status_code" text NOT NULL,
	"normalized_status" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"sanitized_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_events_provider_txn_status_unique" UNIQUE("provider","provider_txn_id","provider_status_code"),
	CONSTRAINT "payment_events_amount_positive" CHECK ("payment_events"."amount" > 0),
	CONSTRAINT "payment_events_currency_supported" CHECK ("payment_events"."currency" in ('USD')),
	CONSTRAINT "payment_events_provider_supported" CHECK ("payment_events"."provider" in ('payhere', 'fake')),
	CONSTRAINT "payment_events_normalized_status_valid" CHECK ("payment_events"."normalized_status" in ('succeeded', 'pending', 'cancelled', 'failed', 'charged_back')),
	CONSTRAINT "payment_events_payload_sha256_valid" CHECK ("payment_events"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payment_events_sanitized_payload_object" CHECK (jsonb_typeof("payment_events"."sanitized_payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "gateway_payment_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settlement_source" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "payments" SET "updated_at" = "created_at";--> statement-breakpoint
UPDATE "payments"
SET "settled_at" = "created_at", "settlement_source" = 'legacy_backfill'
WHERE "status" = 'succeeded';--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_events_payload_sha256_idx" ON "payment_events" USING btree ("payload_sha256");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_gateway_payment_id_unique" UNIQUE("provider","gateway_payment_id");
