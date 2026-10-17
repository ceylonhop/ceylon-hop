import type { Booking, BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import { IllegalTransitionError } from '../domain/status';

export const SUPERSEDED_BY = 'system:pay-link-superseded';
const REASON = 'superseded by a newer pay link';

export interface SupersedeDeps {
  bookings: Pick<BookingRepo, 'get' | 'setStatus'>;
  payments: Pick<PaymentRepo, 'findByBookingId'>;
  quoteId: string;
  requestId?: string;
}

// A quote's pay link can be re-minted (ops switches the option, re-sends, or makes a part-of-trip
// link) and the new link retires the old one, so the booking the customer started on the old link
// can never be paid through it again — /start answers quote_revised. Left alone it sits in
// payment_pending forever: the watchdog chases it and ops lists show two "awaiting payment"
// bookings for one customer (staging 2026-10-13: CH-MYUBP + CH-D67Z9). When /start creates the
// booking for the NEW link it calls this to close the old one — quietly: no customer email.
//
// Only a draft/payment_pending booking with NO succeeded payment is closed; anything else is
// returned untouched as null. A booking that moved on meanwhile (IllegalTransitionError) is skipped.
// If the customer already has PayHere open on the old booking and pays after this, the webhook lands
// it on the existing loud paid_in_unexpected_status path with the payment row recorded.
export async function cancelSupersededBooking(oldBookingId: string, deps: SupersedeDeps): Promise<Booking | null> {
  const old = await deps.bookings.get(oldBookingId);
  if (!old || (old.status !== 'draft' && old.status !== 'payment_pending')) return null;
  if ((await deps.payments.findByBookingId(old.id)).some((p) => p.status === 'succeeded')) return null;
  try {
    return await deps.bookings.setStatus(old.id, 'cancelled', { reason: REASON, by: SUPERSEDED_BY }, {
      source: 'quote_conversion',
      actorType: 'system',
      requestId: deps.requestId,
      reason: REASON,
      relatedEntityType: 'quote',
      relatedEntityId: deps.quoteId,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) return null; // it moved on; not ours to close
    throw err;
  }
}
