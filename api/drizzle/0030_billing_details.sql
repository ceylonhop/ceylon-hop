-- Billing details captured on the customer pay page (owner, 2026-08-01).
--
-- Until now the PayHere checkout was sent `address: 'N/A'`, `city: 'Colombo'` — hardcoded in
-- the adapter — and a `country` taken from the WhatsApp country-code selector. Fabricated
-- billing data on a live card transaction: wrong in the payment record, and a plausible
-- decline path on internationally-issued cards where the issuer runs AVS.
--
-- Billing belongs to the TRANSACTION, not the person: the same traveller may pay with a
-- different card next time, and a parent/company may pay for someone else's trip. Hence
-- columns on bookings rather than on customers (which stays the LEAD PASSENGER).
--
-- All nullable: existing rows have no billing, and the website booking flow does not collect
-- it — there the adapter now OMITS the fields so PayHere collects them itself, which is
-- strictly better than sending a placeholder.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_first_name text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_last_name  text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_address    text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_city       text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS billing_country    text;
