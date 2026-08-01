import { RATE_CARD, type RateCard, type ExtraCode } from './rateCard';
import type { LineItem } from './types';
import { type ExtraInput, normalizeExtra } from './types';

export const EXTRA_LABELS: Record<ExtraCode, string> = {
  sightseeing: 'Sightseeing stops (up to 3h)',
  'safari-wait': 'Wait for Safari',
  luggage: 'Luggage rack',
  front: 'Child seat',
  flex: 'Flexi ticket',
  waiting: 'Waiting fee',
};

// legNames[i] is the display name of driving leg i (e.g. "Kandy → Ella"). When an extra
// carries a legIndex that resolves against it, the leg is named in the label so ops and the
// traveller can see WHICH day the charge belongs to. Unattributed extras are untouched —
// that is what keeps the website/singleTransfer paths and every golden byte-identical.
export function priceExtras(
  extras: ExtraInput[],
  rateCard: RateCard = RATE_CARD,
  legNames?: string[],
): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const raw of extras) {
    const { code, legIndex } = normalizeExtra(raw);
    const amountCents = (rateCard.extras as Record<string, number>)[code];
    if (amountCents === undefined) throw new Error('UNKNOWN_EXTRA');
    const legName = legIndex != null ? legNames?.[legIndex] : undefined;
    const label = legName ? `${EXTRA_LABELS[code]} — ${legName}` : EXTRA_LABELS[code];
    lineItems.push(
      legIndex != null
        ? { label, amountCents, meta: { kind: 'extra', code, legIndex } }
        : { label, amountCents },
    );
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents };
}

export function depositCents(totalCents: number, rateCard: RateCard = RATE_CARD): number {
  const pct = Math.round((totalCents * rateCard.deposit.pct) / 100);
  return Math.min(pct, rateCard.deposit.capCents);
}
