-- The engine could not price the booking (unresolvable route, or Google Distance Matrix was
-- unavailable and we refuse to charge against a crow-flies estimate). `total` is a placeholder
-- in that case, so checkout must refuse the booking until ops sets a real price.
-- Nullable and additive: every existing row is priced, so NULL reads as "chargeable".
ALTER TABLE "bookings" ADD COLUMN "needs_pricing" boolean;
