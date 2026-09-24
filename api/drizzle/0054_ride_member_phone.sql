-- Ride Board traveller phone (owner ask 2026-09-23: "phone number should be there when you open
-- the pane for shared rides"). The join form has always asked for a number, but it was only
-- forwarded to PayHere for the card approval and never stored, so ops could not reach a board
-- traveller on WhatsApp. The API now REQUIRES it on every new commitment; the column is
-- nullable only because members who joined before this migration have no number on file.
-- Additive and instant (no default, no rewrite): nothing existing reads or writes it.
ALTER TABLE "ride_list_member" ADD COLUMN "phone" text;
