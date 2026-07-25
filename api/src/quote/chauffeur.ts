// api/src/quote/chauffeur.ts
import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import { billableKm } from './private';
import type { ChauffeurRideDay, LineItem } from './types';
import { rideRawKm } from './types';
import { winningZoneForStops, zoneBoostForStops, zoneAnnotation } from './hotZones';

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
): { lineItems: LineItem[]; subtotalCents: number; meta: { days: number; idleDays: number; travelKm: number; idleKm: number; billableKm: number; boostedBillableKm: number } } {
  const { vehicle, firstDate, lastDate, travelDays } = input;
  const days = Math.max(1, dayNumber(lastDate) - dayNumber(firstDate) + 1);
  const idleDays = Math.max(0, days - travelDays.length);
  const travelKm = travelDays.reduce((sum, d) => sum + rideRawKm(d), 0);
  const bufferedTravelKm = travelDays.reduce((sum, d) => sum + billableKm(rideRawKm(d), rateCard), 0);
  const idleKm = idleDays * rateCard.chauffeur.idleMinKm[vehicle];
  // Buffer applies to each travel leg only; idle-day minimum km are NOT buffered (decision I1-b)
  const bill = bufferedTravelKm + idleKm;

  // Hot zones (D10): the per-km charge is boosted per DAY, not on the aggregate. A custom rate is
  // authoritative → no boost (D11). Rather than round each day separately (which would drift the
  // zero-zone total), we fold each day's boost into a single "boost-weighted km" sum, so the charge
  // is still ONE rounding: at boost=1 every day weights ×1 and this equals the old `bill × perKm`.
  const zones = input.customPerKmCents != null ? undefined : rateCard.hotZones;
  const weightedTravelKm = travelDays.reduce(
    (sum, d) => sum + billableKm(rideRawKm(d), rateCard) * zoneBoostForStops(d.stops, zones),
    0,
  );
  // An idle day has no location of its own; it inherits where the vehicle is parked — the final stop
  // of the last travel day (D10). (The data can't sequence idle days between travel days, so all
  // idle days take that trailing "parked" boost; documented limitation for v1.)
  const parkStop = travelDays.length ? travelDays[travelDays.length - 1].stops.slice(-1) : [];
  const idleBoost = zoneBoostForStops(parkStop, zones);
  const boostedBill = weightedTravelKm + idleKm * idleBoost;

  const dayCharge = days * rateCard.chauffeur.dayRateCents;
  const distanceCharge = Math.round(boostedBill * (input.customPerKmCents ?? rateCard.perKmCents[vehicle]));

  // Founder-only annotation (D9): the largest zone touched across every travel day + the parked stop.
  const annotationZone = winningZoneForStops(
    [...travelDays.flatMap((d) => d.stops), ...parkStop],
    zones,
  );
  const distMeta: Record<string, unknown> = { vehicle };
  if (annotationZone && distanceCharge > Math.round(bill * (input.customPerKmCents ?? rateCard.perKmCents[vehicle]))) {
    distMeta.hotZone = zoneAnnotation(annotationZone);
  }

  const lineItems: LineItem[] = [
    { label: `Chauffeur day rate — ${days} day(s)`, amountCents: dayCharge },
    { label: `Distance — ${bill} km (${bufferedTravelKm} buffered travel + ${idleKm} idle-day min)`, amountCents: distanceCharge, meta: distMeta },
  ];
  return { lineItems, subtotalCents: dayCharge + distanceCharge, meta: { days, idleDays, travelKm, idleKm, billableKm: bill, boostedBillableKm: boostedBill } };
}
