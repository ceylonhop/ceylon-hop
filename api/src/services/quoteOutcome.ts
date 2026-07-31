import type { QuoteRepo } from '../db/quoteRepo';

// A quote is stamped 'won' the moment ops converts it — before a cent has arrived. If that
// booking is later cancelled or refunded, the business did not happen, and leaving the quote
// 'won' overstates every founder-facing number built on it: the Funnel's Won tile and
// wonValue, and Demand's per-route wonValueCents all sum totalCents over won rows.
//
// So the outcome follows the booking. 'lost' with an explicit reason is the existing
// vocabulary for "we didn't get this one", and it lands the quote in the lost-reasons
// breakdown where a cancelled conversion is worth seeing rather than hidden.
//
// Deliberately NOT applied to a no-show: the fare is forfeited, so we keep the money and the
// quote really was won. The repo stamps decidedAt only when it is still null, so a flip keeps
// the original decision date and the row stays in the analytics window it always sat in.
export type DeadBookingReason = 'Booking cancelled' | 'Booking refunded';

// Best-effort by design — every caller is a money action that has already succeeded, and a
// bookkeeping tidy-up must never undo or fail it. Returns the reason applied, or null when
// there was nothing to do (no source quote, or it is not a won ops quote).
export async function releaseWonQuote(
  bookingId: string,
  reason: DeadBookingReason,
  deps: { quotes?: QuoteRepo },
): Promise<DeadBookingReason | null> {
  if (!deps.quotes) return null;
  try {
    const quote = await deps.quotes.findByConvertedBookingId(bookingId);
    if (!quote || quote.status !== 'won') return null;
    await deps.quotes.patch(quote.id, {
      status: 'lost',
      lostReason: reason,
      updatedBy: 'system:booking-outcome',
    });
    return reason;
  } catch (err) {
    console.error(`releasing the won quote for booking ${bookingId} failed:`, err);
    return null;
  }
}
