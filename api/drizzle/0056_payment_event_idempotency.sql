ALTER TABLE "payment_events"
  DROP CONSTRAINT IF EXISTS "payment_events_provider_txn_status_unique";

ALTER TABLE "payment_events"
  ADD CONSTRAINT "payment_events_payment_provider_txn_status_unique"
  UNIQUE("payment_id", "provider", "provider_txn_id", "provider_status_code");
