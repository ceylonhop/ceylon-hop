// Add-ons after booking (spec docs/superpowers/specs/2026-11-14-post-booking-add-ons-design.md §4).
// Ops adds rate-card add-ons to a leg of a private booking after it is booked; the customer pays
// for them online. These are the rules, with no I/O: which bookings and legs can take one, when a
// request can still be paid, and what a request is shown as. "Today" is always passed in
// (`isoToday('Asia/Colombo')` at the caller) so nothing here reads a clock.

import { EXTRA_CODES, type ExtraCode } from '../quote/rateCard';
import { EXTRA_LABELS } from '../quote/extrasDeposit';
import { SECURED_STATUSES } from './balance';
import type { StoredLeg } from '../db/addOnRepo';

/** What is stored. Everything else a request is shown as is worked out on read (§4.4). */
export type AddOnRequestStatus = 'open' | 'paid' | 'cancelled';

export type AddOnRequestState =
  | 'awaiting_payment' | 'expired' | 'cancelled_with_booking'
  | 'paid' | 'part_refunded' | 'refunded' | 'cancelled';

export type AddOnCreateError =
  | 'not_private' | 'booking_not_eligible' | 'awaiting_price' | 'legs_missing'
  | 'leg_not_found' | 'leg_not_driven' | 'leg_passed'
  | 'unknown_add_on' | 'duplicate_add_on' | 'already_bought_at_booking';

// A request can still be PAID a little longer than one can be CREATED: `completed` is here so a
// request sent mid-trip stays payable to the end of its leg's day even if ops closes the trip that
// afternoon (owner decision D7).
const PAYABLE_BOOKING_STATUSES: ReadonlySet<string> = new Set([...SECURED_STATUSES, 'completed']);
const ENDED_BOOKING_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'refunded', 'no_show']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// The leg's travel day, or null when it has none we can compare (undated, or not a calendar date).
const legDay = (leg: StoredLeg): string | null =>
  leg.travelDate && ISO_DATE.test(leg.travelDate) ? leg.travelDate : null;

/** Version 1 sells add-ons on private transfers only (D3). `serviceType` is the trip's own
 *  (`booking.input.serviceType`); a single transfer has none. */
export function isPrivateBooking(b: { mode: string; serviceType?: string | null }): boolean {
  return b.mode === 'single' || (b.mode === 'trip' && b.serviceType === 'private');
}

/** Why this booking cannot take a new request, or null when it can (§4.1). */
export function bookingAddOnEligibility(
  b: { mode: string; serviceType?: string | null; status: string; needsPricing?: boolean | null },
  legs: StoredLeg[],
): AddOnCreateError | null {
  if (!isPrivateBooking(b)) return 'not_private';
  if (!SECURED_STATUSES.has(b.status)) return 'booking_not_eligible';
  if (b.needsPricing) return 'awaiting_price';
  if (legs.length === 0) return 'legs_missing';
  return null;
}

/** Why this leg cannot take an add-on, or null when it can (§4.1). `leg` is the one the line names,
 *  looked up among the booking's stored legs: undefined when it is not one of them. */
export function legAddOnEligibility(leg: StoredLeg | undefined, today: string): AddOnCreateError | null {
  if (!leg) return 'leg_not_found';
  if (leg.kind !== 'leg') return 'leg_not_driven';
  const day = legDay(leg);
  if (day !== null && day < today) return 'leg_passed';
  return null;
}

/** Can the customer still pay this request (§4.4)? Every line's leg must be in time: dated today or
 *  later, or undated on a trip that has not finished. Lines point at the stored leg, so moving a
 *  leg's date moves the deadline with it. */
export function isAddOnRequestPayable(
  req: { status: AddOnRequestStatus; lines: Array<{ legId: string }> },
  booking: { status: string },
  legs: StoredLeg[],
  today: string,
): boolean {
  if (req.status !== 'open') return false;
  if (!PAYABLE_BOOKING_STATUSES.has(booking.status)) return false;
  return req.lines.every((line) => {
    const leg = legs.find((l) => l.id === line.legId);
    if (!leg) return false;
    const day = legDay(leg);
    return day !== null ? day >= today : booking.status !== 'completed';
  });
}

/** What a request is shown as (§4.4). `refundedCents` is the confirmed refunds on its payment. */
export function addOnRequestState(
  req: { status: AddOnRequestStatus; totalCents: number; lines: Array<{ legId: string }> },
  booking: { status: string },
  legs: StoredLeg[],
  today: string,
  refundedCents: number,
): AddOnRequestState {
  if (req.status === 'cancelled') return 'cancelled';
  if (req.status === 'paid') {
    if (refundedCents >= req.totalCents) return 'refunded';
    return refundedCents > 0 ? 'part_refunded' : 'paid';
  }
  if (ENDED_BOOKING_STATUSES.has(booking.status)) return 'cancelled_with_booking';
  return isAddOnRequestPayable(req, booking, legs, today) ? 'awaiting_payment' : 'expired';
}

/** The PayHere order id of a request's payment: the booking reference plus the request's number. */
export function addOnOrderId(reference: string, seq: number): string {
  return `${reference}-A${seq}`;
}

export function addOnIdempotencyKey(bookingId: string, requestId: string): string {
  return `checkout:${bookingId}:addon:${requestId}`;
}

/** The customer-facing line, frozen when ops sends the request. Same shape as a per-leg quote
 *  extra (`priceExtras`): "Waiting fee — Kandy → Ella". */
export function addOnLineLabel(code: string, from: string, to: string): string {
  return `${EXTRA_LABELS[code as ExtraCode] ?? code} — ${from} → ${to}`;
}

/** What ops can pick from: the private add-ons (`EXTRA_CODES`, so never the shared-only hotel
 *  pick-up / drop-off) at the given card's prices. An add-on the card does not price above zero is
 *  left out: a line must cost something (the table refuses a zero amount). */
export function addOnCatalogue(
  extras: Record<string, number>,
): Array<{ code: string; label: string; priceCents: number }> {
  return EXTRA_CODES.filter((code) => extras[code] > 0).map((code) => ({
    code,
    label: EXTRA_LABELS[code],
    priceCents: extras[code],
  }));
}
