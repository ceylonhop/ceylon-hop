-- Distance cache (spec 2026-08-12 §Distance cache): road distances for catalogue-town pairs,
-- so a customer price is a DB lookup instead of a billed Google Distance Matrix call per leg.
--
-- Rows are DIRECTIONAL (A→B and B→A are separate rows — real routing differs by direction) and
-- keyed on canonPlace() output, the same normalisation place_resolutions uses, so every
-- front-end spelling of a town converges on one row.
--
-- No TTL and no auto-refresh: a distance (and therefore a price) changes only when someone
-- reruns scripts/distance-report.ts --refresh and reviews the deltas. source stays 'google'
-- by design — estimated (haversine) distances are never written, so an outage cannot poison
-- the cache with approximations.
CREATE TABLE IF NOT EXISTS distance_cache (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_key     text NOT NULL,
  to_key       text NOT NULL,
  km           double precision NOT NULL,
  duration_min integer NOT NULL,
  source       text NOT NULL DEFAULT 'google',
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT distance_cache_pair UNIQUE (from_key, to_key)
);
