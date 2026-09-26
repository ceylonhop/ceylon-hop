-- Founder-set rate revisions (spec docs/superpowers/specs/2026-09-26-ops-rates-page-design.md §8.1).
-- Append-only: each save from the ops Rates page adds a row, and the newest (highest seq) is the
-- live rate card's editable set. rateCard.ts holds the defaults until the first save, so an empty
-- table is today's prices exactly. seq is UNIQUE so two saves racing from the same base cannot both
-- land; the API turns the loser into a 409.
CREATE TABLE IF NOT EXISTS "rate_card_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" integer NOT NULL,
  "version" text NOT NULL,
  "rates" jsonb NOT NULL,
  "reverted_to_version" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rate_card_revisions_seq_unique" UNIQUE("seq"),
  CONSTRAINT "rate_card_revisions_version_unique" UNIQUE("version")
);

-- 0048 enabled RLS on every table that existed then; a newer table must protect itself. No policy:
-- the rows carry our costs, which no PostgREST-facing role may read. The API connects as postgres,
-- which bypasses RLS.
ALTER TABLE "rate_card_revisions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "rate_card_revisions" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE rate_card_revisions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE rate_card_revisions FROM authenticated';
  END IF;
END $$;
