-- M23.3 — immutable evidence for applied booking status transitions.
--
-- Rollout is guarded by BOOKING_TRANSITION_TRACKING_ENABLED (default off): deploy this
-- additive table first, then enable writes only after M23.4 covers every status writer.
-- Rollback is to disable that flag; the table stays in place so already-recorded evidence
-- is never destroyed. No legacy rows are backfilled because that would invent history.
CREATE TABLE IF NOT EXISTS "booking_status_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id"),
  "from_status" text NOT NULL,
  "to_status" text NOT NULL,
  "source" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "reason" text,
  "request_id" uuid,
  "run_id" uuid,
  "related_entity_type" text,
  "related_entity_id" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "booking_status_events_from_status_valid"
    CHECK ("from_status" IN ('draft', 'payment_pending', 'awaiting_details', 'paid', 'confirmed', 'in_progress', 'completed', 'cancelled', 'refunded', 'no_show')),
  CONSTRAINT "booking_status_events_to_status_valid"
    CHECK ("to_status" IN ('draft', 'payment_pending', 'awaiting_details', 'paid', 'confirmed', 'in_progress', 'completed', 'cancelled', 'refunded', 'no_show')),
  CONSTRAINT "booking_status_events_source_valid"
    CHECK ("source" IN ('website', 'ops', 'payment_webhook', 'quote_conversion', 'refund', 'scheduled_job', 'migration', 'system')),
  CONSTRAINT "booking_status_events_actor_type_valid"
    CHECK ("actor_type" IN ('customer', 'staff', 'provider', 'scheduler', 'migration', 'system')),
  CONSTRAINT "booking_status_events_related_entity_type_valid"
    CHECK ("related_entity_type" IS NULL OR "related_entity_type" IN ('payment', 'refund', 'quote', 'fulfilment'))
);

CREATE INDEX IF NOT EXISTS "booking_status_events_booking_occurred_idx"
  ON "booking_status_events" ("booking_id", "occurred_at", "id");
CREATE INDEX IF NOT EXISTS "booking_status_events_request_id_idx"
  ON "booking_status_events" ("request_id");
CREATE INDEX IF NOT EXISTS "booking_status_events_run_id_idx"
  ON "booking_status_events" ("run_id");

-- Migration 0048 protected every table that existed then; later tables must protect themselves.
-- The API connects as postgres and bypasses RLS. PostgREST's public roles get no policy and no grant.
ALTER TABLE "booking_status_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "booking_status_events" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE booking_status_events FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE booking_status_events FROM authenticated';
  END IF;
END $$;
