-- Refunds issued through PayHere's Refund API, not by hand (spec: docs/payhere-refund-api-spec.md).
--
-- Until now every refund was manual: request → issue it in the PayHere dashboard → paste the
-- reference back. Three new statuses carry the API path alongside it.
--
--   api_processing  we are about to call PayHere, or have called and do not yet know the outcome
--   api_confirmed   PayHere returned status 1; gateway_ref is their refund number
--   api_failed      PayHere returned status 0 or -1 — the money definitely did NOT move
--
-- `api_processing` is the state this whole design exists for. The Refund API has no idempotency
-- key, so a request that times out cannot be retried: the refund may already have happened. The
-- row is written to api_processing BEFORE the call and stays there on any indefinite answer,
-- for a human to reconcile against PayHere's dashboard.
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_valid;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_valid CHECK (
  status in ('manual_pending', 'manual_confirmed', 'cancelled',
             'api_processing', 'api_confirmed', 'api_failed')
);

-- PayHere's `msg`, so a failure explains itself instead of leaving "-1" in the ledger.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS provider_message text;
-- When we made the call. A row sitting in api_processing past this + a few minutes is the
-- watchdog's signal that someone must go and look.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS api_attempted_at timestamptz;

-- Confirmation evidence: api_confirmed must carry the same proof manual_confirmed does — the
-- gateway reference, who confirmed, when. Anything not confirmed carries none of it.
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_confirmation_evidence_valid;
ALTER TABLE refunds ADD CONSTRAINT refunds_confirmation_evidence_valid CHECK (
  (status in ('manual_confirmed', 'api_confirmed')
     and gateway_ref is not null and confirmed_by is not null and confirmed_at is not null)
  or
  (status not in ('manual_confirmed', 'api_confirmed')
     and gateway_ref is null and confirmed_by is null and confirmed_at is null)
);
