-- Booking checkout attempt log (audit 2026-09-24: in 60 days every incomplete PayHere payment on
-- both channels ended silently -- zero `failed` payment rows -- and nothing on our side recorded
-- the attempt. CH-8UVYG / CH-9SFAG reached PayHere twice within an hour and pressed "Try again"
-- twice, and we cannot say whether they saw a blank frame, a spinner or an error).
--
-- bookings / payments record only where things ENDED UP, and a retry reuses the same payments
-- row without touching it. This is one append-only row per attempt, whatever happened: the
-- create, the checkout, what the PayHere SDK reported in the browser, what the webhook said, and
-- what the return leg answered. Same shape and stance as ride_board_event (0053).
--
-- Additive: a new table plus two defaulted / nullable columns on payments. Written best-effort
-- by the API, so a failure here can never fail a customer's booking or payment.
CREATE TABLE IF NOT EXISTS "booking_checkout_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  -- No foreign key: a create that was refused has no booking row to point at.
  "booking_id" uuid,
  "reference" text,
  "order_id" text,
  "channel" text,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "http_status" integer,
  "attempt" integer,
  "ua" text,
  "source" text NOT NULL,
  CONSTRAINT "booking_checkout_event_action_known"
    CHECK ("action" IN ('create', 'checkout', 'gateway', 'webhook', 'return')),
  CONSTRAINT "booking_checkout_event_outcome_known"
    CHECK ("outcome" IN ('succeeded', 'refused', 'error', 'opened', 'dismissed', 'failed', 'settled', 'pending')),
  CONSTRAINT "booking_checkout_event_source_known" CHECK ("source" IN ('server', 'client'))
);

CREATE INDEX IF NOT EXISTS "booking_checkout_event_at_idx" ON "booking_checkout_event" ("at");
CREATE INDEX IF NOT EXISTS "booking_checkout_event_booking_id_idx" ON "booking_checkout_event" ("booking_id");
CREATE INDEX IF NOT EXISTS "booking_checkout_event_order_id_idx" ON "booking_checkout_event" ("order_id");

-- How many times a checkout was started against this payment, and when the last one was. A
-- retry reuses the row (idempotent per booking), so until now the count was invisible.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;

-- 0048 enabled RLS on every table that existed then; a newer table must protect itself. No
-- policy: PostgREST's public roles have no business reading who tried to pay for what. The API
-- connects as postgres, which bypasses RLS.
ALTER TABLE "booking_checkout_event" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "booking_checkout_event" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE booking_checkout_event FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE booking_checkout_event FROM authenticated';
  END IF;
END $$;
