import { RATE_CARD, type RateCard, type ExtraCode } from './rateCard';
import type { LineItem } from './types';

export const EXTRA_LABELS: Record<ExtraCode, string> = {
  sightseeing: 'Sightseeing stops (up to 3h)',
  'safari-wait': 'Wait for Safari',
  luggage: 'Luggage rack',
  front: 'Child seat',
  flex: 'Flexi ticket',
  waiting: 'Waiting fee',
};

export function priceExtras(codes: ExtraCode[], rateCard: RateCard = RATE_CARD): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const code of codes) {
    const amountCents = (rateCard.extras as Record<string, number>)[code];
    if (amountCents === undefined) throw new Error('UNKNOWN_EXTRA');
    lineItems.push({ label: EXTRA_LABELS[code], amountCents });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents };
}

export function depositCents(totalCents: number, rateCard: RateCard = RATE_CARD): number {
  const pct = Math.round((totalCents * rateCard.deposit.pct) / 100);
  return Math.min(pct, rateCard.deposit.capCents);
}
