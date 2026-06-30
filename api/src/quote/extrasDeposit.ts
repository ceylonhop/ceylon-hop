import { RATE_CARD, type ExtraCode } from './rateCard';
import type { LineItem } from './types';

const EXTRA_LABELS: Record<ExtraCode, string> = {
  sightseeing: 'Sightseeing stops (up to 3h)',
  'safari-wait': 'Wait for Safari',
  luggage: 'Luggage rack',
  front: 'Child seat',
  flex: 'Flexi ticket',
};

export function priceExtras(codes: ExtraCode[]): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const code of codes) {
    const amountCents = (RATE_CARD.extras as Record<string, number>)[code];
    if (amountCents === undefined) throw new Error('UNKNOWN_EXTRA');
    lineItems.push({ label: EXTRA_LABELS[code], amountCents });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents };
}

export function depositCents(totalCents: number): number {
  const pct = Math.round((totalCents * RATE_CARD.deposit.pct) / 100);
  return Math.min(pct, RATE_CARD.deposit.capCents);
}
