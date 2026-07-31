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

// The other direction (spec D6, 2026-07-31): payment SETTLING is what wins a quote. The
// pay-link flow stamps convertedBookingId at pay-commit but deliberately leaves the quote's
// status alone — a booking sitting in Awaiting payment is not business won. When money
// actually lands (PayHere webhook, or ops recording cash via mark-paid), this flips the
// quote to won. Only from ready|sent: ready because payment can land before ops marks
// sent; never from a decided state — a lost/expired quote that somehow gets paid is a
// human situation, not one a hook should rewrite. Best-effort like releaseWonQuote: the
// money is the durable fact and a bookkeeping failure must never break settlement.
export async function claimWonQuote(
  bookingId: string,
  deps: { quotes?: QuoteRepo },
): Promise<boolean> {
  if (!deps.quotes) return false;
  try {
    const quote = await deps.quotes.findByConvertedBookingId(bookingId);
    if (!quote || (quote.status !== 'ready' && quote.status !== 'sent')) return false;
    await deps.quotes.patch(quote.id, { status: 'won', updatedBy: 'system:payment-settled' });
    return true;
  } catch (err) {
    console.error(`claiming the won quote for booking ${bookingId} failed:`, err);
    return false;
  }
}
