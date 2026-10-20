-- M23.6 — signed Resend webhook facts. Existing application events remain unchanged;
-- these three values distinguish provider evidence from local attempts and acceptance.
ALTER TABLE "customer_communication_events"
  DROP CONSTRAINT "customer_communication_events_type_valid";
--> statement-breakpoint
ALTER TABLE "customer_communication_events"
  ADD CONSTRAINT "customer_communication_events_type_valid"
  CHECK ("event_type" in ('planned', 'suppressed', 'send_attempted', 'provider_accepted', 'send_failed', 'provider_sent', 'delivered', 'delayed', 'provider_failed', 'bounced', 'complained'));
