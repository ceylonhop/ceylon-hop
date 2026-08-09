-- Billing postcode (owner, 2026-08-02).
--
-- The pay form collected street, city and country but no postcode — and a postcode is the
-- single strongest AVS signal most card issuers check. PayHere's checkout parameters have no
-- dedicated postcode field, so it is appended to the `address` line (documented as "Address
-- Line1 + Line2", i.e. free text) AND stored here for our own records.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_postcode text;
