import type { SavedQuote } from '../db/quoteRepo';
import type { LineItem, QuoteRequest } from './types';

// Partial-leg pay links (spec 2026-08-04). The ONE place a partial link's amount is decided.
//
// The rule is the owner's: a partial link charges the line prices the quote ALREADY shows,
// added up. So this module READS `quote.result.lineItems` — the engine's own output, re-priced
// on every save — and never recomputes a price. Two hazards that buys us out of:
//   • a second pricing implementation (quoteBreakdown) kept in parity with the engine by hand;
//   • the rate card, where an expired `rateLockedUntil` makes rateCardFor() return the LIVE
//     card, which would price these lines off today's numbers against yesterday's total.
//
// Line order is fixed by engine.ts: the first `engine.legs.length` items are the driving legs,
// then the extras in request order, then an optional price_adjustment (the charm finishing).
// The adjustment is excluded — by rule it never applies to a subset (spec §4).
//
// Floors come for free: the engine already applies max(floorCents[vehicle], raw) per private
// leg, so any subset of n legs clears n × floor — exactly the `protectedMinimumCents` the
// engine defends. See §11 of the spec.

export interface PaySelection {
  legIndexes: number[];
  extraIndexes: number[];
}

export interface PayLine {
  kind: 'leg' | 'extra';
  /** Index into `engine.legs` or `engine.extras` — positional, matching the `legIndex` convention. */
  index: number;
  label: string;
  amountCents: number;
  /** Extras only: the driving leg this charge belongs to, when it was attributed. */
  legIndex?: number;
}

/** Engine rows that are not customer charge lines and can never be part of a selection. */
const NON_CHARGE_KINDS = new Set(['price_adjustment', 'discount']);

/** Thrown when a quote can't produce charge lines — chauffeur, shell, or a legacy row. */
export class NotLineablePriceError extends Error {}

/**
 * Every charge line of a private quote, read from its stored result: legs first (in `engine.legs`
 * order), then extras (in `engine.extras` order). Throws for anything that isn't a priced private
 * quote — a chauffeur leg carries only its km share, so a subset of them sums to a meaningless
 * number (spec §3).
 */
export function payLines(quote: SavedQuote): PayLine[] {
  const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
  if (!engine || engine.product !== 'private') throw new NotLineablePriceError('not a private quote');
  const items = (quote.result as { lineItems?: LineItem[] } | null)?.lineItems;
  if (!Array.isArray(items)) throw new NotLineablePriceError('quote has no priced line items');

  const legCount = engine.legs.length;
  // A shell or a half-saved row would slice legs out of thin air; refuse rather than invent.
  if (items.length < legCount) throw new NotLineablePriceError('fewer line items than legs');

  const legLines: PayLine[] = items.slice(0, legCount).map((item, i) => ({
    kind: 'leg',
    index: i,
    label: item.label,
    amountCents: item.amountCents,
  }));

  // Everything after the legs is an extra, except the engine's own non-charge rows. An
  // UNATTRIBUTED extra carries no meta at all, so extras cannot be identified by meta —
  // position is the contract, and it matches `engine.extras` one-for-one.
  //
  // NON_CHARGE_KINDS is why the discount row is tagged. Without the tag it would land in this
  // slice, survive the filter, and be mapped as an extra — putting a NEGATIVE, tickable line on
  // the hosted pay page and shifting every extraIndex a stored pay_link_selection points at.
  // See the discounts design §5.6 / parent §18.5.
  const extraLines: PayLine[] = items
    .slice(legCount)
    .filter((item) => !NON_CHARGE_KINDS.has((item.meta as { kind?: string } | undefined)?.kind ?? ''))
    .map((item, i) => {
      const legIndex = (item.meta as { legIndex?: number } | undefined)?.legIndex;
      return {
        kind: 'extra' as const,
        index: i,
        label: item.label,
        amountCents: item.amountCents,
        ...(typeof legIndex === 'number' ? { legIndex } : {}),
      };
    });

  return [...legLines, ...extraLines];
}

const ticked = (line: PayLine, sel: PaySelection): boolean =>
  line.kind === 'leg' ? sel.legIndexes.includes(line.index) : sel.extraIndexes.includes(line.index);

export function selectionAmountCents(lines: PayLine[], sel: PaySelection): number {
  return lines.filter((l) => ticked(l, sel)).reduce((sum, l) => sum + l.amountCents, 0);
}

/** True when nothing was unticked — the caller must then use the quote's stored total (spec §4). */
export function isFullSelection(lines: PayLine[], sel: PaySelection): boolean {
  return lines.every((l) => ticked(l, sel));
}

/** A selection is contiguous when its legs form an unbroken run. Empty is not contiguous. */
export function isContiguous(legIndexes: number[]): boolean {
  if (!legIndexes.length) return false;
  const sorted = [...legIndexes].sort((a, b) => a - b);
  return sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
}

/** The leg name a gap opens after, for the ops warning — null when the selection is contiguous. */
export function gapAfterLeg(lines: PayLine[], sel: PaySelection): string | null {
  if (isContiguous(sel.legIndexes)) return null;
  const sorted = [...sel.legIndexes].sort((a, b) => a - b);
  const holeAt = sorted.findIndex((n, i) => i > 0 && n !== sorted[i - 1] + 1);
  if (holeAt < 1) return null;
  const prev = sorted[holeAt - 1];
  return lines.find((l) => l.kind === 'leg' && l.index === prev)?.label ?? null;
}
