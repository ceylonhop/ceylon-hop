-- Offer validity (spec 2026-08-05 D9). How long the PRICE is honoured, as distinct from how
-- long the quote link works — link liveness is status-driven (D8) and has no clock.
--
-- Set on the transition into `ready` as approval + 7 days, reset on re-approval. Nullable:
-- every quote predating this renders with it null, which the page treats as "no validity
-- shown" rather than "lapsed". Deliberately NOT rate_locked_until: ops quotes lock at
-- approval with rate_locked_until = null, which is exactly why this column has to exist.
ALTER TABLE "quotes" ADD COLUMN "offer_valid_until" timestamptz;
