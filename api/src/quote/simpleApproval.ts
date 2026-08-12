// api/src/quote/simpleApproval.ts
// Which quotes an `ops` agent may approve without a founder (plan 2026-08-11).
//
// A quote qualifies when ALL FIVE hold: it is a private transfer, it has exactly one leg, it is
// not on the custom vehicle tier, it carries no hand-set $/km, and it has no active discount.
// Anything else stays founder-only. Approval is what unlocks the pay-link mint and the booking
// conversion, so this predicate is the gate on ops taking a customer's money against a price no
// second person reviewed — it fails CLOSED on every shape it does not positively recognise.
//
// ── The field-name trap ───────────────────────────────────────────────────────────────────────
// The stored request is a WRAPPER: `{ tool, engine }` (internalQuote.ts, POST /save). The two
// halves name the same concepts differently:
//
//            tool (authored itinerary)            engine (what was priced)
//   legs     includes stay_day legs               driving legs only, private branch
//   vehicle  car | van_6 | van_9 | van_14         car | van | van9 | van14
//   $/km     customRatePerKmCents                 customPerKmCents
//
// This module reads `engine` ONLY — never `tool`, never a mix. Reading the wrong half fails
// asymmetrically: a bad leg-count read yields `undefined === 1` → false → nothing qualifies, which
// is loud and safe; a bad custom-rate read yields `undefined == null` → true → "no custom rate" →
// the quote PASSES, silently self-approving the hand-priced quote this rule exists to exclude.
// If you change this file, change its test fixtures the same way: they are real /save round-trips
// precisely so a hand-authored object cannot encode the mistake and go green.
import type { SavedQuote } from '../db/quoteRepo';

// Engine-side vehicle names (see the table above). An ALLOW-list, not `!== 'custom'`, so a future
// tier added to the rate card is founder-only until someone decides otherwise.
const STANDARD_VEHICLES: ReadonlySet<string> = new Set(['car', 'van', 'van9', 'van14']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

export function canOpsSelfApprove(quote: SavedQuote): boolean {
  const engine = asRecord(asRecord(quote.request)?.engine);
  if (!engine) return false; // unpriced shell, legacy row, or anything malformed

  if (engine.product !== 'private') return false;
  if (!Array.isArray(engine.legs) || engine.legs.length !== 1) return false;
  if (typeof engine.vehicle !== 'string' || !STANDARD_VEHICLES.has(engine.vehicle)) return false;
  if (engine.customPerKmCents != null) return false;

  // An active discount is visible on the stored RESULT: the engine emits `discount` (and
  // `discountCents`) whenever one was applied, and a re-save reprices with it, so the pair
  // tracks the live state rather than the history. Removing the discount drops both.
  const result = asRecord(quote.result);
  if (result?.discount != null) return false;
  if (typeof result?.discountCents === 'number' && result.discountCents > 0) return false;

  return true;
}
