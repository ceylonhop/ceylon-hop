// api/src/quote/quoteAlternative.ts
// The chauffeur alternative frozen onto a "both" quote at /save (owner 2026-10-12, spec PR #964).
//
// A quote the customer asked for as "both" is priced point-to-point; the chauffeur-guide figure
// used to be recomputed live every time it was shown, so the number on the builder card, the
// copied message and the customer's page could drift from the one that was approved. /save now
// freezes it in `quotes.result_json` under `result.alt` (no migration), and the readers below
// prefer the stored number. Pure: no repo, no clock, no rate card.
import type { SavedQuote } from '../db/quoteRepo';
import { drives } from './legCategory';
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
