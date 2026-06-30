// api/src/quote/engine.ts
import { RATE_CARD } from './rateCard';
import type { QuoteRequest, QuoteResult, LineItem } from './types';
import { selectVehicle } from './vehicle';
import { quotePrivateLegs } from './private';
import { quoteSharedLegs } from './shared';
import { quoteChauffeur } from './chauffeur';
import { priceExtras, depositCents } from './extrasDeposit';

export function quote(req: QuoteRequest): QuoteResult {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  let subtotalCents = 0;
  let costCents = 0;

  if (req.product === 'shared') {
    if (req.legs.length === 0) throw new Error('NO_LEGS');
    const s = quoteSharedLegs(req.legs);
    lineItems.push(...s.lineItems);
    subtotalCents += s.subtotalCents;
    // shared cost basis not modelled → margin reported as 0 (see warning)
    warnings.push('margin not modelled for shared');
  } else if (req.product === 'private') {
    if (req.legs.length === 0) throw new Error('NO_LEGS');
    const minVehicle = selectVehicle(req.pax, req.bags);
    if (minVehicle === 'too_big') throw new Error('TOO_BIG');
    // Price with the LARGER of (requested, required) — never below what the party needs; a van upgrade is allowed.
    // (Do NOT trust req.vehicle blindly: car requested for 6 pax must not be priced as a car.)
    const vehicle = req.vehicle === 'van' || minVehicle === 'van' ? 'van' : 'car';
    if (vehicle !== req.vehicle) warnings.push(`vehicle set to ${vehicle} for ${req.pax} pax / ${req.bags} bags`);
    const p = quotePrivateLegs(req.legs, vehicle);
    lineItems.push(...p.lineItems);
    warnings.push(...p.warnings);
    subtotalCents += p.subtotalCents;
    costCents += req.legs.reduce((s, l) => s + Math.round(l.distanceKm * RATE_CARD.costPerKmCents[vehicle]), 0);
    if (req.extras?.length) {
      const e = priceExtras(req.extras);
      lineItems.push(...e.lineItems);
      subtotalCents += e.subtotalCents;
    }
  } else {
    if (req.travelDays.length === 0) throw new Error('NO_LEGS');
    const c = quoteChauffeur(req);
    lineItems.push(...c.lineItems);
    subtotalCents += c.subtotalCents;
    costCents += Math.round(c.meta.billableKm * RATE_CARD.costPerKmCents[req.vehicle]);
    if (req.extras?.length) {
      const e = priceExtras(req.extras);
      lineItems.push(...e.lineItems);
      subtotalCents += e.subtotalCents;
    }
  }

  const totalCents = subtotalCents;
  const deposit = depositCents(totalCents);
  const amountDueNowCents = req.product === 'chauffeur' ? deposit : totalCents;

  return {
    product: req.product,
    currency: 'USD',
    lineItems,
    subtotalCents,
    totalCents,
    depositCents: deposit,
    amountDueNowCents,
    marginEstimateCents: totalCents - costCents,
    rateCardVersion: RATE_CARD.version,
    warnings,
  };
}
