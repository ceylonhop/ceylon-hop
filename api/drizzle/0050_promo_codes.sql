-- Promo codes for website bookings (spec docs/superpowers/specs/2026-09-14-promo-codes-design.md §8.1).
-- Uses are NOT stored here. They are counted from bookings (promo_code_id + promo_hold_until) and
-- payments, so there is no counter that can drift from the bookings it describes. Additive only.
CREATE TABLE "promo_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "method" text NOT NULL,
  "value" integer NOT NULL,
  "starts_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "max_uses" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone,
  CONSTRAINT "promo_codes_code_unique" UNIQUE ("code"),
  CONSTRAINT "promo_codes_code_shape" CHECK ("code" ~ '^[A-Z0-9-]{3,32}$'),
  CONSTRAINT "promo_codes_method_valid" CHECK ("method" in ('fixed', 'percentage')),
  CONSTRAINT "promo_codes_value_valid" CHECK (
    ("method" = 'percentage' AND "value" BETWEEN 100 AND 3000) OR ("method" = 'fixed' AND "value" > 0)
  ),
  CONSTRAINT "promo_codes_max_uses_positive" CHECK ("max_uses" >= 1),
  CONSTRAINT "promo_codes_window_valid" CHECK ("starts_at" IS NULL OR "starts_at" < "expires_at"),
  CONSTRAINT "promo_codes_created_by_present" CHECK (btrim("created_by") <> '')
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "promo_code_id" uuid REFERENCES "promo_codes"("id");
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "promo_hold_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "bookings_promo_code_idx" ON "bookings" ("promo_code_id");
--> statement-breakpoint
-- 0048 enabled RLS on every table that existed then; a newer table must protect itself (0049 did
-- the same). No policy: PostgREST roles have no business here. The API's postgres role bypasses RLS.
ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "promo_codes" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE promo_codes FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE promo_codes FROM authenticated';
  END IF;
END $$;
