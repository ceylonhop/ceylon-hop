// api/src/quote/chauffeur.ts
import { RATE_CARD, type Vehicle } from './rateCard';
import { billableKm } from './private';
import type { ChauffeurTravelDay, LineItem } from './types';

// Parse only the YYYY-MM-DD part as UTC midnight, so a time/offset never shifts the day count.
function dayNumber(date: string): number {
  const ymd = date.slice(0, 10);
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
}

export function quoteChauffeur(input: {
  vehicle: Vehicle;
  firstDate: string;
  lastDate: string;
  travelDays: ChauffeurTravelDay[];
}): { lineItems: LineItem[]; subtotalCents: number; meta: { days: number; idleDays: number; travelKm: number; idleKm: number; billableKm: number } } {
  const { vehicle, firstDate, lastDate, travelDays } = input;
  const days = Math.max(1, dayNumber(lastDate) - dayNumber(firstDate) + 1);
  const idleDays = Math.max(0, days - travelDays.length);
  const travelKm = travelDays.reduce((sum, d) => sum + d.distanceKm, 0);
  const idleKm = idleDays * RATE_CARD.chauffeur.idleMinKm[vehicle];
  // Buffer applies to travel km only; idle-day minimum km are NOT buffered (decision I1-b)
  const bill = billableKm(travelKm) + idleKm;

  const dayCharge = days * RATE_CARD.chauffeur.dayRateCents;
  const distanceCharge = Math.round(bill * RATE_CARD.perKmCents[vehicle]);

  const lineItems: LineItem[] = [
    { label: `Chauffeur day rate — ${days} day(s)`, amountCents: dayCharge },
    { label: `Distance — ${bill} km (${billableKm(travelKm)} buffered travel + ${idleKm} idle-day min)`, amountCents: distanceCharge, meta: { vehicle } },
  ];
  return { lineItems, subtotalCents: dayCharge + distanceCharge, meta: { days, idleDays, travelKm, idleKm, billableKm: bill } };
}
