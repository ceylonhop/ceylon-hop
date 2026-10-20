-- M23.5 — additive, default-off customer communication observation ledger.
-- It neither authorizes nor deduplicates sends: notification_log and the existing guard remain
-- authoritative. Rollback is disabling CUSTOMER_COMMUNICATION_TRACKING_ENABLED; evidence stays.
CREATE TABLE IF NOT EXISTS "customer_communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"template_key" text NOT NULL,
	"template_version" text NOT NULL,
	"recipient" text NOT NULL,
	"source" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"request_id" uuid,
	"run_id" uuid,
	"tracking_key" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_communications_tracking_key_unique" UNIQUE("tracking_key"),
	CONSTRAINT "customer_communications_provider_message_id_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "customer_communications_channel_valid" CHECK ("channel" = 'email'),
	CONSTRAINT "customer_communications_kind_valid" CHECK ("kind" in ('confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice', 'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received')),
	CONSTRAINT "customer_communications_source_valid" CHECK ("source" in ('website', 'ops', 'payment_webhook', 'quote_conversion', 'refund', 'scheduled_job', 'migration', 'system')),
	CONSTRAINT "customer_communications_actor_type_valid" CHECK ("actor_type" in ('customer', 'staff', 'provider', 'scheduler', 'migration', 'system')),
	CONSTRAINT "customer_communications_payload_sha256_valid" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_communication_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"communication_id" uuid,
	"event_type" text NOT NULL,
	"provider_event_id" text,
	"provider_message_id" text,
	"reason_code" text,
	"detail_json" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_communication_events_provider_event_id_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "customer_communication_events_type_valid" CHECK ("event_type" in ('planned', 'suppressed', 'send_attempted', 'provider_accepted', 'send_failed', 'delivered', 'bounced', 'complained')),
	CONSTRAINT "customer_communication_events_link_valid" CHECK ("communication_id" is not null or "provider_message_id" is not null),
	CONSTRAINT "customer_communication_events_detail_object" CHECK ("detail_json" is null or jsonb_typeof("detail_json") = 'object')
);
--> statement-breakpoint
ALTER TABLE "customer_communications" ADD CONSTRAINT "customer_communications_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_communication_events" ADD CONSTRAINT "customer_communication_events_communication_id_customer_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."customer_communications"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "customer_communications_booking_created_idx" ON "customer_communications" USING btree ("booking_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "customer_communications_request_id_idx" ON "customer_communications" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX "customer_communications_run_id_idx" ON "customer_communications" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "customer_communication_events_communication_recorded_idx" ON "customer_communication_events" USING btree ("communication_id","recorded_at","id");
--> statement-breakpoint
CREATE INDEX "customer_communication_events_provider_message_idx" ON "customer_communication_events" USING btree ("provider_message_id");
--> statement-breakpoint
ALTER TABLE "customer_communications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_communication_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "customer_communications", "customer_communication_events" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE customer_communications, customer_communication_events FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE customer_communications, customer_communication_events FROM authenticated';
  END IF;
END $$;
