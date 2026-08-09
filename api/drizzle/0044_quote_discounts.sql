-- Founder manual discounts (spec docs/superpowers/specs/2026-08-09-founder-manual-discounts-design.md).
-- One row per discount DECISION, never mutated in place: apply inserts, replace/remove supersedes.
-- That is what makes the history an audit trail rather than a current-state column on `quotes`.
--
-- Why the before/after money is STORED and not derived:
--   • total_after_cents is NOT total_before_cents - applied_cents. Psychological finishing runs
--     AFTER the discount, so the final total carries an adjustment computed from the discounted
--     subtotal. Recomputing later, against a rate card that may since have moved, would not
--     reproduce the number the customer was actually shown.
--   • the margin pair is the margin AS IT STOOD when the founder decided. Recomputing it after a
--     rate-card change would quietly rewrite history.
--
-- estimated_cost_cents and the margin pair are REPORTING ONLY. The limits are the 30% ceiling and
-- the vehicle fare floor (§5.2) — cost is deliberately not a control, because a per-km cost
-- estimate understates a short trip badly: the driver charges a fixed minimum to take the job.
--
-- Table only. No creation path exists until OPS_MANUAL_DISCOUNTS_ENABLED is turned on, and reading
-- an existing row is unconditional from the moment this lands.
CREATE TABLE "quote_discounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id"),
  -- The quote revision this was decided at. A STAMP, not a foreign key: quote_revisions holds only
  -- SUPERSEDED states, so the live revision has no row there to reference (migration 0040).
  "quote_revision" integer NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "method" text NOT NULL,
  -- Cents for 'fixed', basis points for 'percentage' — the founder's raw input, kept verbatim.
  "value" integer NOT NULL,
  "reason" text NOT NULL,
  "subtotal_before_cents" integer NOT NULL,
  "total_before_cents" integer NOT NULL,
  "requested_cents" integer NOT NULL,
  "applied_cents" integer NOT NULL,
  "total_after_cents" integer NOT NULL,
  "cap_reason" text,
  "estimated_cost_cents" integer,
  "margin_before_cents" integer,
  "margin_after_cents" integer,
  "applied_by" text NOT NULL,
  "applied_at" timestamptz DEFAULT now() NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "superseded_by" text,
  "superseded_at" timestamptz,
  CONSTRAINT "quote_discounts_source_valid" CHECK ("source" in ('manual', 'promotion')),
  CONSTRAINT "quote_discounts_method_valid" CHECK ("method" in ('fixed', 'percentage')),
  CONSTRAINT "quote_discounts_status_valid" CHECK ("status" in ('active', 'replaced', 'removed')),
  CONSTRAINT "quote_discounts_cap_reason_valid"
    CHECK ("cap_reason" is null or "cap_reason" in ('percentage_cap', 'vehicle_minimum')),
  CONSTRAINT "quote_discounts_reason_present" CHECK (btrim("reason") <> ''),
  CONSTRAINT "quote_discounts_money_non_negative" CHECK (
    "value" >= 0 and "subtotal_before_cents" >= 0 and "total_before_cents" >= 0
    and "requested_cents" >= 0 and "applied_cents" >= 0 and "total_after_cents" >= 0
    and ("estimated_cost_cents" is null or "estimated_cost_cents" >= 0)
  ),
  -- The engine can only ever reduce a request, never inflate it.
  CONSTRAINT "quote_discounts_applied_within_requested" CHECK ("applied_cents" <= "requested_cents"),
  -- A discount cannot remove more than the quote was worth.
  CONSTRAINT "quote_discounts_applied_within_subtotal" CHECK ("applied_cents" <= "subtotal_before_cents"),
  -- A superseded row records who ended it and when; an active row records neither. Enforced so a
  -- half-written supersede cannot leave the history ambiguous about who removed a discount.
  CONSTRAINT "quote_discounts_supersede_complete" CHECK (
    ("status" = 'active' and "superseded_by" is null and "superseded_at" is null)
    or ("status" <> 'active' and "superseded_by" is not null and "superseded_at" is not null)
  )
);
--> statement-breakpoint
-- At most ONE live discount per quote. Partial, so superseded rows accumulate freely — the whole
-- point of the table. This is the constraint that makes "replace" safe under concurrency.
CREATE UNIQUE INDEX "quote_discounts_one_active_per_quote"
  ON "quote_discounts" ("quote_id") WHERE "status" = 'active';
--> statement-breakpoint
-- History reads are always "this quote, newest first".
CREATE INDEX "quote_discounts_quote_idx" ON "quote_discounts" ("quote_id", "applied_at" DESC);
