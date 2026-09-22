-- The leg a shared booking actually sold (CH-6HE3V, owner-reported 2026-09-21).
--
-- A shared booking stored only its corridor_id. A corridor is the ROAD a van drives, and
-- since the directed catalogue landed (2026-08-16) one corridor carries several legs at
-- their own prices -- so every label rebuilt the journey from the corridor's endpoints and
-- told a CMB -> Sigiriya customer, in their confirmation email and on the ops board, that
-- they were booked through to Kandy.
--
-- Additive and nullable. A null means "this row never recorded its leg", which the label
-- resolver reports as the SERVICE rather than inventing a destination for it.
ALTER TABLE shared_request ADD COLUMN IF NOT EXISTS from_place text;
ALTER TABLE shared_request ADD COLUMN IF NOT EXISTS to_place text;

-- Backfill only what is unambiguous. Within a corridor a product's boarding time identifies
-- it -- that is the catalogue's own key -- so (corridor_id, time) recovers the leg for every
-- historical row EXCEPT ella-south, whose Ella -> Weligama and Ella -> Ahangama legs both
-- board at 09:00 for the same fare and are genuinely indistinguishable from a stored row.
-- Those stay null deliberately: guessing there is the bug this migration closes.
--
-- time is trimmed because the stored value is the request's string, not the catalogue's.
-- This runs once, here, so the derivation never becomes a runtime dependency on a file the
-- owner can edit -- changing a boarding time must never rewrite what a past customer bought.
UPDATE shared_request SET from_place = 'Colombo Airport (CMB)', to_place = 'Sigiriya / Dambulla'
  WHERE corridor_id = 'airport-cultural' AND btrim(time) = '07:00' AND from_place IS NULL;
UPDATE shared_request SET from_place = 'Negombo', to_place = 'Sigiriya / Dambulla'
  WHERE corridor_id = 'airport-cultural' AND btrim(time) = '07:30' AND from_place IS NULL;
UPDATE shared_request SET from_place = 'Sigiriya / Dambulla', to_place = 'Kandy'
  WHERE corridor_id = 'airport-cultural' AND btrim(time) = '11:30' AND from_place IS NULL;
UPDATE shared_request SET from_place = 'Ella', to_place = 'Yala'
  WHERE corridor_id = 'ella-east' AND btrim(time) = '09:00' AND from_place IS NULL;
UPDATE shared_request SET from_place = 'Mirissa', to_place = 'Colombo Airport (CMB)'
  WHERE corridor_id = 'south-airport' AND btrim(time) = '14:45' AND from_place IS NULL;
UPDATE shared_request SET from_place = 'Weligama', to_place = 'Colombo Airport (CMB)'
  WHERE corridor_id = 'south-airport' AND btrim(time) = '15:00' AND from_place IS NULL;
