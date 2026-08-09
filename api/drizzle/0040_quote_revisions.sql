-- Quote version history (spec 2026-08-05 §4). One row per SUPERSEDED state: update() copies the
-- current row here before overwriting it, so history holds what a quote used to be and `quotes`
-- always holds what it is. No duplication of the live state.
--
-- Rows appear only when the content actually changed, so revision numbers have gaps — a gap means
-- the revision counter moved (it bumps unconditionally, which is what retires a pay link on
-- re-approval) while the content did not.
CREATE TABLE "quote_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id"),
  "revision" integer NOT NULL,
  "request_json" jsonb,
  "result_json" jsonb,
  "total_cents" integer NOT NULL,
  "currency" text NOT NULL,
  "rate_card_version" text,
  "status" text,
  "updated_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "quote_revisions_quote_revision_unique" UNIQUE ("quote_id", "revision")
);
CREATE INDEX "idx_quote_revisions_quote" ON "quote_revisions" ("quote_id", "revision" DESC);
