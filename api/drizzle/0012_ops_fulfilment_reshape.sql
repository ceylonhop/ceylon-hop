ALTER TABLE "ride_ops" ALTER COLUMN "fulfilment_status" SET DEFAULT 'paid';
--> statement-breakpoint
UPDATE "ride_ops" SET "fulfilment_status" = CASE "fulfilment_status"
  WHEN 'unassigned' THEN 'paid'
  WHEN 'assigned' THEN 'paid'
  WHEN 'sent_to_coordinator' THEN 'paid'
  WHEN 'acknowledged' THEN 'paid'
  WHEN 'customer_updated' THEN 'pickup_confirmed'
  ELSE "fulfilment_status" END;
