// api/src/quote/engine.ts
import { RATE_CARD, type RateCard, CHAUFFEUR_INCLUDED_EXTRAS } from './rateCard';
import type { QuoteRequest, QuoteResult, LineItem } from './types';
import { normalizeRide, normalizeChauffeurDay, rideRawKm, validateRide, normalizeExtra } from './types';
import { selectVehicle, vehicleRank } from './vehicle';
import { quotePrivateLegs, billableKm } from './private';
import { quoteSharedLegs } from './shared';
import { quoteChauffeur } from './chauffeur';
import { priceExtras, depositCents } from './extrasDeposit';
import { finishPrice } from './priceFinish';
import { resolveDiscount, type DiscountRequest, type ResolvedDiscount } from './discount';

// GL-1d: van14/custom are custom-priced per quote (owner decision 2026-07-02) — the operator
// supplies the per-km rate. Any other tier has an owner-confirmed rate that must not be
// overridable (undercharge/tamper risk), so a stray override is a hard error, not a warning.
function validateCustomRate(customPerKmCents: number | undefined, pricedVehicle: string): number | undefined {
  if (customPerKmCents == null) return undefined;
  if (pricedVehicle !== 'van14' && pricedVehicle !== 'custom') throw new Error('CUSTOM_RATE_ONLY_FOR_CUSTOM_TIERS');
  if (!Number.isInteger(customPerKmCents) || customPerKmCents <= 0) throw new Error('CUSTOM_RATE_INVALID');
  return customPerKmCents;
}

// `rateCard` defaults to the current RATE_CARD; a quote priced against its LOCKED snapshot passes
// that card in (rate-lock spec: docs/superpowers/specs/2026-07-11-quote-rate-lock-design.md).
export function quote(
  req: QuoteRequest,
  rateCard: RateCard = RATE_CARD,
  discountRequest?: DiscountRequest,
): QuoteResult {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  let subtotalCents = 0;
  let costCents = 0;
  let protectedMinimumCents = 0;

  if (req.product === 'shared') {
    if (req.legs.length === 0) throw new Error('NO_LEGS');
    const s = quoteSharedLegs(req.legs, rateCard);
    lineItems.push(...s.lineItems);
    subtotalCents += s.subtotalCents;
    // shared cost basis not modelled → margin reported as 0 (see warning)
    warnings.push('margin not modelled for shared');
  } else if (req.product === 'private') {
    if (req.legs.length === 0) throw new Error('NO_LEGS');
    // Normalize old-shape legs + Ride legs once at entry; validate each (invalid → INVALID_RIDE,
    // surfaced as a 422 by the routes). Everything below prices/counts per RIDE.
    const rides = req.legs.map(normalizeRide);
    rides.forEach(validateRide);
    const minVehicle = selectVehicle(req.pax, req.bags, rateCard);
    if (minVehicle === 'too_big') throw new Error('TOO_BIG');
    // Price with the LARGER of (requested, required) — never below what the party needs; an upgrade is allowed.
    // (Do NOT trust req.vehicle blindly: car requested for 6 pax must not be priced as a car.)
    const vehicle = vehicleRank(req.vehicle) >= vehicleRank(minVehicle) ? req.vehicle : minVehicle;
    if (vehicle !== req.vehicle) warnings.push(`vehicle set to ${vehicle} for ${req.pax} pax / ${req.bags} bags`);
    // GL-1d: a custom per-km rate is only meaningful on the custom-priced tiers. Validate
    // against the PRICED vehicle (an upgrade INTO van14/custom keeps the operator's rate —
    // the rate is set for the trip; the tier is capacity).
    const perKmOverride = validateCustomRate(req.customPerKmCents, vehicle);
    const p = quotePrivateLegs(rides, vehicle, perKmOverride, rateCard);
    lineItems.push(...p.lineItems);
    warnings.push(...p.warnings);
    subtotalCents += p.subtotalCents;
    protectedMinimumCents = rides.length * rateCard.floorCents[vehicle];
    const costPerKm = perKmOverride != null ? Math.round(perKmOverride / (1 + rateCard.markupPct / 100)) : rateCard.costPerKmCents[vehicle];
    // Cost scales by the SAME per-ride hot-zone boost as the sell rate (D6 — the premium is a real
    // servicing cost, not pure margin), so reported margin keeps the standard markup on a zone trip.
    // p.perRideBoost is 1 for every ride at zero zones ⇒ byte-identical to the pre-hot-zones cost.
    costCents += rides.reduce((s, r, i) => s + Math.round(billableKm(rideRawKm(r), rateCard) * costPerKm * p.perRideBoost[i]), 0);
    if (req.extras?.length) {
      // Name each attributed extra after the ride it belongs to, using the SAME
      // stops.join(' → ') that quotePrivateLegs uses for the travel row, so the two
      // rows read as a matched pair. Pushed after the travel items on purpose —
      // ops-ui splits lineItems by "the first N are the driving legs".
      const e = priceExtras(req.extras, rateCard, rides.map((r) => r.stops.join(' → ')));
      lineItems.push(...e.lineItems);
      subtotalCents += e.subtotalCents;
    }
  } else {
    if (req.travelDays.length === 0) throw new Error('NO_LEGS');
    // Normalize old-shape + Ride travel days once at entry; validate each (INVALID_RIDE → 422).
    const travelDays = req.travelDays.map(normalizeChauffeurDay);
    travelDays.forEach(validateRide);
    // Upgrade an undersized vehicle to one that fits the group (mirrors private) — only when the
    // caller supplied pax/bags. A chauffeur car quoted for 6 pax must not price as a car.
    let vehicle = req.vehicle;
    if (req.pax != null && req.bags != null) {
      const minVehicle = selectVehicle(req.pax, req.bags, rateCard);
      if (minVehicle === 'too_big') throw new Error('TOO_BIG');
      vehicle = vehicleRank(req.vehicle) >= vehicleRank(minVehicle) ? req.vehicle : minVehicle;
      if (vehicle !== req.vehicle) warnings.push(`vehicle set to ${vehicle} for ${req.pax} pax / ${req.bags} bags`);
    }
    const perKmOverride = validateCustomRate(req.customPerKmCents, vehicle); // GL-1d (validate against the priced tier)
    const c = quoteChauffeur({ ...req, vehicle, travelDays }, rateCard);
    lineItems.push(...c.lineItems);
    subtotalCents += c.subtotalCents;
    const costPerKm = perKmOverride != null ? Math.round(perKmOverride / (1 + rateCard.markupPct / 100)) : rateCard.costPerKmCents[vehicle];
    // Cost = day-rate cost (per day) + distance cost, so chauffeur margin reflects the real
    // markup on BOTH the day charge and the km (day rate is sold at cost × 1.15 too). The distance
    // cost uses the boost-weighted km (D6/D10), so a zone day's cost rises with its sell charge;
    // boostedBillableKm == billableKm at zero zones ⇒ byte-identical. Day-rate cost is NOT boosted.
    costCents += c.meta.days * rateCard.chauffeur.dayRateCostCents + Math.round(c.meta.boostedBillableKm * costPerKm);
    if (req.extras?.length) {
      // Chauffeur trips include the vehicle all day: sightseeing/waiting/safari-wait are
      // already covered by the day rate and must never be charged again. Owner call
      // (2026-08-01): they are not printed either — a $0 row is noise on a quote where the
      // car is the traveller's all day. The warning stays: it is the only trace that a flag
      // arrived and was deliberately ignored, and the toggle is hidden under chauffeur.
      const normalized = req.extras.map(normalizeExtra);
      const included = normalized.filter((x) => (CHAUFFEUR_INCLUDED_EXTRAS as readonly string[]).includes(x.code));
      const chargeable = normalized.filter((x) => !(CHAUFFEUR_INCLUDED_EXTRAS as readonly string[]).includes(x.code));
      for (const x of included) {
        warnings.push(`${x.code} included in chauffeur day rate`);
      }
      if (chargeable.length) {
        // No legNames here on purpose: the three attributable extras are all included-and-
        // dropped above, so anything still chargeable is a trip-level extra (luggage rack,
        // child seat, flexi) arriving unattributed from the website path.
        const e = priceExtras(chargeable, rateCard);
        lineItems.push(...e.lineItems);
        subtotalCents += e.subtotalCents;
      }
    }
  }

  // Final-price policy is deliberately downstream of every core calculation and runs once.
  // Shared-seat prices stay fixed. Legacy locked rate cards without the policy remain unchanged.
  const finished = req.product !== 'shared' && rateCard.priceFinishing
    ? finishPrice(subtotalCents, Math.max(costCents, protectedMinimumCents), rateCard.priceFinishing)
    : { rawCents: subtotalCents, finalCents: subtotalCents, adjustmentCents: 0, strategy: 'unchanged' as const };
  if (finished.adjustmentCents !== 0) {
    lineItems.push({
      label: 'Final price adjustment',
      amountCents: finished.adjustmentCents,
      meta: { kind: 'price_adjustment', strategy: finished.strategy },
    });
  }

  // Founder manual discount (spec 2026-08-09 §5.1). AFTER finishing, deliberately — owner
  // decision 2026-08-09: a quote goes to the customer at its finished price and the customer then
  // negotiates off THAT. So the discount comes off the number they were actually shown, and the
  // three figures a customer sees reconcile exactly: $62.00 quoted − $10.00 off = $52.00 to pay.
  //
  // Discounting BEFORE finishing (the original design) re-finished the reduced subtotal, so a
  // $10.00 discount off $62.00 landed at $51.99 — the founder's own figure no longer appeared
  // anywhere, and no customer-facing breakdown could be made to add up without exposing the
  // internal finishing row.
  //
  // It also means the undiscounted path is now byte-identical to pre-feature behaviour by
  // construction: finishing sees exactly what it always saw.
  let resolvedDiscount: ResolvedDiscount | undefined;
  let discountCents = 0;
  if (discountRequest) {
    // Shared is per-seat corridor pricing: no vehicle, so no floor to protect it.
    if (req.product === 'shared') throw new Error('DISCOUNT_NOT_SUPPORTED');
    // Both limits now apply to the FINISHED total — the price that was quoted — rather than to a
    // pre-finishing subtotal the customer never saw.
    resolvedDiscount = resolveDiscount(discountRequest, finished.finalCents, protectedMinimumCents);
    discountCents = resolvedDiscount.appliedCents;
    // A zero-cent outcome is NOT a discounted quote — no row for a renderer to show.
    if (discountCents > 0) {
      lineItems.push({
        label: 'Discount',
        amountCents: -discountCents,
        meta: { kind: 'discount' },
      });
    }
  }

  const totalCents = finished.finalCents - discountCents;
  const deposit = depositCents(totalCents, rateCard);
  // amountDueNow is the FULL total for EVERY product, deposit-eligible ones (chauffeur) included.
  // Deliberate owner decision "Charge full amount for all bookings" (2026-07-07, commit 4d58f5a)
  // that replaced the earlier `req.product === 'chauffeur' ? deposit : totalCents` split — so this
  // SUPERSEDES go-live-checklist GL-3 piece 3 (the chauffeur "deposit" charge). `deposit` above
  // stays a separate display-only figure (shown by the ops quote tool, internalQuote.ts); the
  // deposit/balance machinery on the booking side (notifications.ts paidRows, bookings.ts
  // balanceDueCents) is plumbed but dormant — it only lights up if a booking ever stores
  // amountDueNow < total, which no public flow currently does.
  const amountDueNowCents = totalCents;
  const marginEstimateCents = req.product === 'shared' ? null : totalCents - costCents;

  return {
    product: req.product,
    currency: 'USD',
    lineItems,
    subtotalCents,
    totalCents,
    priceAdjustmentCents: finished.adjustmentCents,
    priceStrategy: finished.strategy,
    depositCents: deposit,
    amountDueNowCents,
    marginEstimateCents,
    // Spread so the keys are ABSENT, not undefined, when nothing was requested — an undiscounted
    // result must serialize exactly as it did before this feature (see goldens.test.ts).
    ...(resolvedDiscount
      ? {
          discountCents,
          // What the customer was quoted BEFORE negotiating — the finished price. This is the
          // "Total" line on the customer quote page, and totalBefore − discount === total exactly.
          totalBeforeDiscountCents: finished.finalCents,
          discount: resolvedDiscount,
        }
      : {}),
    rateCardVersion: rateCard.version,
    warnings,
  };
}
