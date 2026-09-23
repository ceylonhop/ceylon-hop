-- Ride Board attempt log (owner ask 2026-09-22: "I need all the metrics I can get").
--
-- ride_list / ride_list_member record only where things ENDED UP, and a retry overwrites the
-- member row. Every refused join ("that list just closed" -- EA-8707), every refused start,
-- every card approval that was declined, cancelled or abandoned left no trace at all. This is
-- one append-only row per attempt, whatever happened.
--
-- Additive: a new table, nothing existing is touched. Written best-effort by the API, so a
-- failure here can never fail a traveller's join.
CREATE TABLE IF NOT EXISTS "ride_board_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "http_status" integer,
  "list_code" text,
  "corridor_id" text,
  "from_place" text,
  "to_place" text,
  "ride_date" text,
  "slot" text,
  "seats" integer,
  "customer_sub" text,
  "country" text,
  "order_id" text,
  CONSTRAINT "ride_board_event_action_known" CHECK ("action" IN ('start', 'join', 'scratch')),
  CONSTRAINT "ride_board_event_outcome_known"
    CHECK ("outcome" IN ('refused', 'payment_started', 'payment_failed', 'succeeded', 'error'))
);

CREATE INDEX IF NOT EXISTS "ride_board_event_at_idx" ON "ride_board_event" ("at");
CREATE INDEX IF NOT EXISTS "ride_board_event_list_code_idx" ON "ride_board_event" ("list_code");

-- 0048 enabled RLS on every table that existed then; a newer table must protect itself. No
-- policy: PostgREST's public roles have no business reading who tried to book what. The API
-- connects as postgres, which bypasses RLS.
ALTER TABLE "ride_board_event" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "ride_board_event" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE ride_board_event FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE ride_board_event FROM authenticated';
  END IF;
END $$;
