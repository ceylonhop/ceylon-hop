// api/src/quote/engine.ts
import { RATE_CARD, CHAUFFEUR_INCLUDED_EXTRAS } from './rateCard';
import type { QuoteRequest, QuoteResult, LineItem } from './types';
import { selectVehicle, vehicleRank } from './vehicle';
import { quotePrivateLegs, billableKm } from './private';
import { quoteSharedLegs } from './shared';
import { quoteChauffeur } from './chauffeur';
import { priceExtras, depositCents, EXTRA_LABELS } from './extrasDeposit';

// GL-1d: van14/custom are custom-priced per quote (owner decision 2026-07-02) — the operator
// supplies the per-km rate. Any other tier has an owner-confirmed rate that must not be
// overridable (undercharge/tamper risk), so a stray override is a hard error, not a warning.
function validateCustomRate(customPerKmCents: number | undefined, pricedVehicle: string): number | undefined {
  if (customPerKmCents == null) return undefined;
  if (pricedVehicle !== 'van14' && pricedVehicle !== 'custom') throw new Error('CUSTOM_RATE_ONLY_FOR_CUSTOM_TIERS');
  if (!Number.isInteger(customPerKmCents) || customPerKmCents <= 0) throw new Error('CUSTOM_RATE_INVALID');
  return customPerKmCents;
}

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
    // Price with the LARGER of (requested, required) — never below what the party needs; an upgrade is allowed.
    // (Do NOT trust req.vehicle blindly: car requested for 6 pax must not be priced as a car.)
    const vehicle = vehicleRank(req.vehicle) >= vehicleRank(minVehicle) ? req.vehicle : minVehicle;
    if (vehicle !== req.vehicle) warnings.push(`vehicle set to ${vehicle} for ${req.pax} pax / ${req.bags} bags`);
    // GL-1d: a custom per-km rate is only meaningful on the custom-priced tiers. Validate
    // against the PRICED vehicle (an upgrade INTO van14/custom keeps the operator's rate —
    // the rate is set for the trip; the tier is capacity).
    const perKmOverride = validateCustomRate(req.customPerKmCents, vehicle);
    const p = quotePrivateLegs(req.legs, vehicle, perKmOverride);
    lineItems.push(...p.lineItems);
    warnings.push(...p.warnings);
    subtotalCents += p.subtotalCents;
    const costPerKm = perKmOverride != null ? Math.round(perKmOverride / (1 + RATE_CARD.markupPct / 100)) : RATE_CARD.costPerKmCents[vehicle];
    costCents += req.legs.reduce((s, l) => s + Math.round(billableKm(l.distanceKm) * costPerKm), 0);
    if (req.extras?.length) {
      const e = priceExtras(req.extras);
      lineItems.push(...e.lineItems);
      subtotalCents += e.subtotalCents;
    }
  } else {
    if (req.travelDays.length === 0) throw new Error('NO_LEGS');
    // Upgrade an undersized vehicle to one that fits the group (mirrors private) — only when the
    // caller supplied pax/bags. A chauffeur car quoted for 6 pax must not price as a car.
    let vehicle = req.vehicle;
    if (req.pax != null && req.bags != null) {
      const minVehicle = selectVehicle(req.pax, req.bags);
      if (minVehicle === 'too_big') throw new Error('TOO_BIG');
      vehicle = vehicleRank(req.vehicle) >= vehicleRank(minVehicle) ? req.vehicle : minVehicle;
      if (vehicle !== req.vehicle) warnings.push(`vehicle set to ${vehicle} for ${req.pax} pax / ${req.bags} bags`);
    }
    const perKmOverride = validateCustomRate(req.customPerKmCents, vehicle); // GL-1d (validate against the priced tier)
    const c = quoteChauffeur({ ...req, vehicle });
    lineItems.push(...c.lineItems);
    subtotalCents += c.subtotalCents;
    const costPerKm = perKmOverride != null ? Math.round(perKmOverride / (1 + RATE_CARD.markupPct / 100)) : RATE_CARD.costPerKmCents[vehicle];
    costCents += Math.round(c.meta.billableKm * costPerKm);
    if (req.extras?.length) {
      // Chauffeur trips include the vehicle all day: sightseeing/waiting/safari-wait are
      // already covered by the day rate and must never be charged again.
      const included = req.extras.filter((code) => (CHAUFFEUR_INCLUDED_EXTRAS as readonly string[]).includes(code));
      const chargeable = req.extras.filter((code) => !(CHAUFFEUR_INCLUDED_EXTRAS as readonly string[]).includes(code));
      for (const code of included) {
        warnings.push(`${code} included in chauffeur day rate`);
        lineItems.push({ label: `${EXTRA_LABELS[code]} (included)`, amountCents: 0 });
      }
      if (chargeable.length) {
        const e = priceExtras(chargeable);
        lineItems.push(...e.lineItems);
        subtotalCents += e.subtotalCents;
      }
    }
  }

  const totalCents = subtotalCents;
  const deposit = depositCents(totalCents);
  const amountDueNowCents = totalCents;
  const marginEstimateCents = req.product === 'shared' ? null : totalCents - costCents;

  return {
    product: req.product,
    currency: 'USD',
    lineItems,
    subtotalCents,
    totalCents,
    depositCents: deposit,
    amountDueNowCents,
    marginEstimateCents,
    rateCardVersion: RATE_CARD.version,
    warnings,
  };
}
