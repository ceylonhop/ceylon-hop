-- Widen the payments.provider whitelist for out-of-band settlement.
-- POST /admin/bookings/:id/mark-paid records money that moved outside any gateway
-- (cash, bank transfer, other manual channel) and writes that channel into provider.
-- The 0027 whitelist only knew the two gateways, so every mark-paid would 23514.
-- Widening means dropping and re-adding: existing rows are all 'payhere' or 'fake',
-- so they satisfy the wider set by construction, but we keep 0027's NOT VALID then
-- VALIDATE idiom so the rewrite never takes a long ACCESS EXCLUSIVE validation lock.
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_provider_supported";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_supported" CHECK ("payments"."provider" in ('payhere', 'fake', 'cash', 'bank_transfer', 'manual_other')) NOT VALID;--> statement-breakpoint

ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_provider_supported";
