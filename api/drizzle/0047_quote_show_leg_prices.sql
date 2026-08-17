-- Per-journey price breakdown (spec 2026-08-16). Gates the customer-facing per-leg breakdown
-- on ONE quote. A display setting, deliberately a column rather than a field inside
-- request_json: that blob is what the quote was PRICED from, and quoteDiff plus re-price on
-- reopen both read it, so a cosmetic tick has no business editing it.
--
-- NOT NULL DEFAULT false: every existing quote is off, which is the required default, and the
-- column needs no backfill.
ALTER TABLE "quotes" ADD COLUMN "show_leg_prices" boolean DEFAULT false NOT NULL;
