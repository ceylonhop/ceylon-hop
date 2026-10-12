// api/src/quote/quoteAlternative.ts
// The chauffeur alternative frozen onto a "both" quote at /save (owner 2026-10-12, spec PR #964).
//
// A quote the customer asked for as "both" is priced point-to-point; the chauffeur-guide figure
// used to be recomputed live every time it was shown, so the number on the builder card, the
// copied message and the customer's page could drift from the one that was approved. /save now
// freezes it in `quotes.result_json` under `result.alt` (no migration), and the readers below
// prefer the stored number. Pure: no repo, no clock, no rate card.
import type { Booking } from '../db/bookingRepo';
import type { SavedQuote } from '../db/quoteRepo';
import { drives } from './legCategory';
import { chosenAddOns, isServiceSelection, legSelectionOf } from './paySelection';
import type { QuoteRequest, QuoteResult } from './types';

export interface QuoteAlternative {
  product: 'chauffeur';
  engine: Extract<QuoteRequest, { product: 'chauffeur' }>;
  result: QuoteResult;
}

/**
 * The ONE copy of "can this itinerary be priced as a chauffeur trip": every leg that drives or is
 * a stay day carries a date, and they span two or more distinct dates. Returns the reason it
 * cannot (the text the ops chooser shows), or null when it can. Shared by the live service
 * chooser and the /save freeze so the two can never disagree about eligibility.
 */
export function chauffeurFeasibility(legs: { category?: string; date?: string }[]): string | null {
  const chauffeurLegs = legs.filter((l) => drives(l) || (l.category || 'transfer') === 'stay_day');
  const distinctDates = new Set(chauffeurLegs.map((l) => l.date).filter(Boolean));
  if (chauffeurLegs.some((l) => !l.date)) return 'add a date to every leg';
  if (distinctDates.size <= 1) return 'single-day — point-to-point only';
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The stored chauffeur alternative of a quote, or null. Fails closed on every shape it does not
 * positively recognise, because a reader that trusted a malformed `alt` would show — and later
 * charge — a number nobody approved. It applies only to a quote asked for as "both" and priced
 * point-to-point, and never to a discounted one (owner decision D2: the discount belongs to the
 * point-to-point price only).
 */
export function alternativeOf(
  quote: Pick<SavedQuote, 'request' | 'result' | 'requestedService'>,
): QuoteAlternative | null {
  if (quote.requestedService !== 'both') return null;
  if (asRecord(asRecord(quote.request)?.engine)?.product !== 'private') return null;

  const result = asRecord(quote.result);
  if (!result) return null;
  if (result.discount != null) return null;
  if (typeof result.discountCents === 'number' && result.discountCents > 0) return null;

  const alt = asRecord(result.alt);
  if (!alt || alt.product !== 'chauffeur') return null;
  if (asRecord(alt.engine)?.product !== 'chauffeur') return null;
  const altResult = asRecord(alt.result);
  if (!altResult || altResult.product !== 'chauffeur' || altResult.currency !== 'USD') return null;
  if (!isCents(altResult.totalCents) || altResult.totalCents <= 0) return null;
  if (!isCents(altResult.depositCents) || !isCents(altResult.amountDueNowCents)) return null;
  if (!Array.isArray(altResult.lineItems)) return null;

  return alt as unknown as QuoteAlternative;
}

/** The quote with the chauffeur alternative taken as its own product, total and engine. */
function projectAlt(quote: SavedQuote, alt: QuoteAlternative): SavedQuote {
  return {
    ...quote,
    product: alt.product,
    totalCents: alt.result.totalCents,
    marginCents: alt.result.marginEstimateCents ?? null,
    request: { ...(asRecord(quote.request) ?? {}), engine: alt.engine },
    result: alt.result,
    payLinkSelection: null,
    soldCents: null,
  };
}

/**
 * The quote AS SOLD on its pay link, for a link that has NO booking yet. Unchanged (the very same
 * object) when the selection is empty or a part-of-trip one; with `{ service: 'chauffeur' }`, the
 * quote with `product`, `totalCents`, `marginCents`, `request.engine` and `result` taken from the
 * frozen alternative and the selection and `soldCents` cleared — so every reader below it (copy,
 * deposit offer, booking) sees an ordinary whole-trip chauffeur quote and needs no idea that a
 * "both" quote sits behind it.
 *
 * Returns null — "this link is not payable" — when the selection has nothing valid behind it: a
 * selection that is neither a leg selection nor a chauffeur one, no recognisable alternative, or a
 * frozen `soldCents` that is not the alternative's total. Failing closed is the point: a charge
 * must never be built from a product and an amount that disagree.
 */
export function soldView(quote: SavedQuote): SavedQuote | null {
  const sel = quote.payLinkSelection;
  if (!sel) return quote;
  if (!isServiceSelection(sel)) return legSelectionOf(sel) ? quote : null;
  const alt = alternativeOf(quote);
  if (!alt || quote.soldCents !== alt.result.totalCents) return null;
  return projectAlt(quote, alt);
}

/** The booking's own product: a chauffeur trip. Decided by the booking, never by the quote's current selection. */
export function isChauffeurBooking(b: Pick<Booking, 'mode' | 'input'>): boolean {
  return b.mode === 'trip' && (b.input as { serviceType?: string }).serviceType === 'chauffeur';
}

// The primary quote with any service selection ignored (a leg selection is the caller's business).
function withoutService(quote: SavedQuote): SavedQuote {
  return isServiceSelection(quote.payLinkSelection) ? { ...quote, payLinkSelection: null, soldCents: null } : quote;
}

/**
 * The quote AS SOLD once a booking exists. The selection lives on the QUOTE and moves whenever the
 * agent re-mints, but a booking already created stays what it was — so a customer paying an earlier
 * booking after the link was switched must be described by that booking:
 *   - a chauffeur booking whose total is the frozen alternative's → the chauffeur projection,
 *     whatever the quote's selection says now;
 *   - any other booking → the primary quote, a service selection ignored (a leg selection is left
 *     as it is);
 *   - no booking → the selection-based view, falling back to the primary rather than null.
 * Never null: someone who has paid must never meet a dead end (primary copy is the worst case).
 */
export function soldViewFor(quote: SavedQuote, booking: Pick<Booking, 'mode' | 'input' | 'total'> | null): SavedQuote {
  if (!booking) return soldView(quote) ?? withoutService(quote);
  if (isChauffeurBooking(booking)) {
    const alt = alternativeOf(quote);
    if (alt && booking.total === alt.result.totalCents) return projectAlt(quote, alt);
  }
  return withoutService(quote);
}

/**
 * The add-ons a BOOKING bought, named from its quote. A chauffeur booking bought none (the stored
 * lines are the private quote's); any other booking gets what it would with no service selection.
 */
export function addOnsFor(
  quote: Pick<SavedQuote, 'request' | 'result' | 'payLinkSelection'>,
  booking: Pick<Booking, 'mode' | 'input'>,
): string[] {
  if (isChauffeurBooking(booking)) return [];
  return chosenAddOns(quote, legSelectionOf(quote.payLinkSelection));
}
