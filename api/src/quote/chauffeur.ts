// api/src/quote/chauffeur.ts
import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import { billableKm } from './private';
import type { ChauffeurRideDay, LineItem } from './types';
import { rideRawKm } from './types';

// Parse only the YYYY-MM-DD part as UTC midnight, so a time/offset never shifts the day count.
function dayNumber(date: string): number {
  const ymd = date.slice(0, 10);
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
}

export function quoteChauffeur(
  input: {
    vehicle: Vehicle;
    firstDate: string;
    lastDate: string;
    travelDays: ChauffeurRideDay[];
    // GL-1d: operator's custom rate for van14/custom — validated by engine.ts.
    customPerKmCents?: number;
  },
  rateCard: RateCard = RATE_CARD,
): { lineItems: LineItem[]; subtotalCents: number; meta: { days: number; idleDays: number; travelKm: number; idleKm: number; billableKm: number } } {
  const { vehicle, firstDate, lastDate, travelDays } = input;
  const days = Math.max(1, dayNumber(lastDate) - dayNumber(firstDate) + 1);
  const idleDays = Math.max(0, days - travelDays.length);
  const travelKm = travelDays.reduce((sum, d) => sum + rideRawKm(d), 0);
  const bufferedTravelKm = travelDays.reduce((sum, d) => sum + billableKm(rideRawKm(d), rateCard), 0);
  const idleKm = idleDays * rateCard.chauffeur.idleMinKm[vehicle];
  // Buffer applies to each travel leg only; idle-day minimum km are NOT buffered (decision I1-b)
  const bill = bufferedTravelKm + idleKm;

  const dayCharge = days * rateCard.chauffeur.dayRateCents;
  const distanceCharge = Math.round(bill * (input.customPerKmCents ?? rateCard.perKmCents[vehicle]));

  const lineItems: LineItem[] = [
    { label: `Chauffeur day rate — ${days} day(s)`, amountCents: dayCharge },
    { label: `Distance — ${bill} km (${bufferedTravelKm} buffered travel + ${idleKm} idle-day min)`, amountCents: distanceCharge, meta: { vehicle } },
  ];
  return { lineItems, subtotalCents: dayCharge + distanceCharge, meta: { days, idleDays, travelKm, idleKm, billableKm: bill } };
}
