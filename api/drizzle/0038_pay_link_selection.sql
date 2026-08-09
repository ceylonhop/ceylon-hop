-- Partial-leg pay links (spec 2026-08-04). Additive: a quote with no selection behaves exactly
-- as it did before. pay_link_seq is monotonic per quote and is never reset — a seq must never be
-- reused by a later selection, or a retired link would validate again.
ALTER TABLE "quotes" ADD COLUMN "pay_link_selection" jsonb;
ALTER TABLE "quotes" ADD COLUMN "sold_cents" integer;
ALTER TABLE "quotes" ADD COLUMN "pay_link_seq" integer DEFAULT 0 NOT NULL;
