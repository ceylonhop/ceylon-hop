-- Branded short links for customer quote and payment URLs. Only a SHA-256 digest of the
-- bearer code is stored; the target is enough to rebuild the existing signed token after lookup.
CREATE TABLE "customer_short_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_digest" text NOT NULL UNIQUE,
  "kind" text NOT NULL,
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE CASCADE,
  "quote_revision" integer,
  "pay_link_seq" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_short_links_digest_shape" CHECK (
    "code_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "customer_short_links_target_shape" CHECK (
    ("kind" = 'quote_view' AND "quote_revision" IS NULL AND "pay_link_seq" IS NULL)
    OR
    ("kind" = 'quote_pay'
      AND "quote_revision" IS NOT NULL AND "quote_revision" >= 1
      AND "pay_link_seq" IS NOT NULL AND "pay_link_seq" >= 0)
  )
);

CREATE INDEX "customer_short_links_quote_idx" ON "customer_short_links" ("quote_id");

-- 0048 enabled RLS on every table that existed then. This table is newer, so it must protect
-- itself explicitly. No policy is added: PostgREST's anon/authenticated roles have no business
-- reading customer capabilities. The backend's postgres role bypasses RLS.
ALTER TABLE "customer_short_links" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "customer_short_links" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE customer_short_links FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE customer_short_links FROM authenticated';
  END IF;
END $$;
