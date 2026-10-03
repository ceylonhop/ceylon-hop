-- Server-side GA4 (docs/superpowers/specs/2026-10-03-server-side-ga4-purchase-design.md).
-- Two analytics-only tables, additive. Nothing on the money path reads them.
--
-- booking_ga_identity: the GA visitor (client id) and session the customer checked out from,
-- so the server's purchase joins that visit in GA4. One row per booking; the latest checkout
-- wins. No foreign key, like booking_checkout_event: best-effort writes must never fail a checkout.
CREATE TABLE IF NOT EXISTS "booking_ga_identity" (
  "booking_id" uuid PRIMARY KEY NOT NULL,
  "client_id" text,
  "session_id" text,
  "ad_consent" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "booking_ga_identity_client_id_shape"
    CHECK ("client_id" IS NULL OR "client_id" ~ '^[0-9]{1,20}\.[0-9]{1,20}$'),
  CONSTRAINT "booking_ga_identity_session_id_shape"
    CHECK ("session_id" IS NULL OR "session_id" ~ '^[0-9]{6,12}$'),
  CONSTRAINT "booking_ga_identity_ad_consent_known"
    CHECK ("ad_consent" IS NULL OR "ad_consent" IN ('granted', 'denied', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "booking_ga_identity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- ga4_event_log: the exactly-once ledger AND the outbox. `payload` is the exact Measurement
-- Protocol hit built at first claim; retries re-send it unchanged.
CREATE TABLE IF NOT EXISTS "ga4_event_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_key" text NOT NULL UNIQUE,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "payload" jsonb NOT NULL,
  "last_error" text,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ga4_event_log_kind_known" CHECK ("kind" IN ('purchase', 'refund', 'board_purchase')),
  CONSTRAINT "ga4_event_log_status_known" CHECK ("status" IN ('claimed', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ga4_event_log_status_idx" ON "ga4_event_log" ("status");
--> statement-breakpoint
ALTER TABLE "ga4_event_log" ENABLE ROW LEVEL SECURITY;
