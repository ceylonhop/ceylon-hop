-- Why a booking was cancelled, and by whom (owner rule, 2026-08-02).
--
-- Cancelling recorded nothing at all: the booking flipped to 'cancelled' and the reason lived
-- only in whoever's memory pressed the button. Refunds already carry reason + requestedBy in
-- the refunds ledger; cancellation is the same class of irreversible act and now matches.
--
-- This lands alongside the rule that an ops agent may cancel or refund only up to 24 hours
-- before the trip starts (founders any time) — a time-bounded grant is only auditable if the
-- reason and the actor are actually written down.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
