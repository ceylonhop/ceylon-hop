-- Who took the money, in a column a lower-privileged role cannot erase.
--
-- mark-paid recorded the actor ONLY by appending free text to ride_ops.ops_notes
-- ("Marked paid — cash · REF · by alice@…"). That field is writable through
-- POST /admin/ops/bookings/:id/flags, which needs bookings:operate — held by the `ops` role,
-- which is deliberately DENIED payments:act. So the one person not trusted to record money
-- could delete the record of who recorded it. SH8 gave manual REFUNDS immutable
-- requested_by/confirmed_by columns (0028); manual capture shipped without the equivalent.
--
-- The CHECK is added NOT VALID and is deliberately NEVER validated. Manual payments taken
-- before this migration have no actor anywhere except those same mutable notes, so there is
-- nothing trustworthy to backfill from — reconstructing an actor by parsing the field we do
-- not trust would be inventing evidence, which is precisely what the refund ledger exists to
-- avoid. Existing rows are grandfathered; every manual settlement from here carries its actor.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "settled_by" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_manual_settlement_actor_required"
  CHECK ("payments"."settlement_source" <> 'manual' OR "payments"."settled_by" IS NOT NULL) NOT VALID;
