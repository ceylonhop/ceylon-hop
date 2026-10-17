-- Usage counters (spec 2026-10-13 §1). Hand-written: drizzle-kit generate needs a TTY.
-- One row per UTC day and counter key — provider email sends against the Resend caps, live Google
-- calls per method, 429s served — written by services/usageMeter.ts as coalesced upserts that ADD
-- (`n + excluded.n`), so two writers never lose a count. Read only by the ops Health tab. Additive:
-- nothing else references it, so dropping the table is the whole rollback.
CREATE TABLE "usage_counters" (
	"day" date NOT NULL,
	"key" text NOT NULL,
	"n" integer NOT NULL DEFAULT 0,
	CONSTRAINT "usage_counters_pkey" PRIMARY KEY("day","key")
);
--> statement-breakpoint
-- Migration 0048 protected every table that existed then; later tables protect themselves (see
-- 0058, 0060, 0065). The API connects as postgres and bypasses RLS; PostgREST's public roles get no grant.
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;
