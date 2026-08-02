-- Billing state / province (owner, 2026-08-02).
--
-- The pay form asked for street, city, postcode and country, but not the state — so US and
-- Canadian payers typed it into the city box ("Jersey City, NJ"), which is the field the
-- gateway forwards as the city. PayHere has no state parameter either, so like the postcode
-- it rides on the `address` line and is stored here for our own records.
--
-- Nullable: every pre-existing row has none, most countries do not use one, and it is never
-- required to pay.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_state text;
