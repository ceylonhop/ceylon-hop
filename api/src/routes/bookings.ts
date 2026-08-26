import { Hono } from 'hono';
import { SingleTransferInput, BillingInput } from '../domain/singleTransfer';
import { TripInput } from '../domain/trip';
import { SharedBookingRequest } from '../domain/shared';
import {
  isoToday,
  isPastIsoDate,
  firstPastDate,
  isoWeekday,
  serviceDaysLabel,
  isTooSoonPrivate,
  isTooSoonChauffeur,
  PRIVATE_MIN_LEAD_HOURS,
  CHAUFFEUR_MIN_LEAD_DAYS,
} from '../domain/dateRules';
import {
  priceSingle,
  priceTrip,
  priceShared,
  quoteSingleTransfer,
  quoteTrip,
  InvalidPricingRequestError,
  type PriceOutcome,
} from '../services/pricing';
import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentAdapter } from '../adapters/payments';
import type { DepartureRepo } from '../db/departureRepo';
import { sharedProductFor } from '../db/departureRepo';
import type { MapsAdapter, DistanceResult } from '../adapters/maps';
import type { ConciergeTaskRepo } from '../db/conciergeTaskRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { rateCardFor } from '../quote/rateLock';
import { RATE_CARD, type RateCard } from '../quote/rateCard';
import { InMemoryZonesRepo, type ZonesRepo } from '../db/zonesRepo';
import { liveRateCard } from '../quote/liveCard';
import {
  signCheckoutToken,
  signPayReturnToken,
  verifyBookingToken,
  verifyPayReturnToken,
  verifyCheckoutToken,
} from '../lib/bookingToken';

// Minimum-notice copy. Customer-facing, so it states the rule rather than the field that failed.
const PRIVATE_NOTICE_MESSAGE = `Private transfers need at least ${PRIVATE_MIN_LEAD_HOURS} hours' notice — please pick a later pick-up.`;
const CHAUFFEUR_NOTICE_MESSAGE = `Chauffeur-guide trips need at least ${CHAUFFEUR_MIN_LEAD_DAYS} days' notice — please pick a later start date.`;

// GL-3 — how far the site's quotedTotal may drift from the engine price before ops is
// flagged ($1 absorbs rounding differences, never a real disagreement).
const MISMATCH_TOLERANCE_CENTS = 100;
const UNPRICED_NOTE = 'unpriced booking — distance unresolved, verify price';
const UNPRICED_NOTE_PREFIX = 'unpriced booking — set a price before this can be paid';

// One maps lookup per route pair per request: engine pricing and the M8 enrichment share
// results, so going engine-first doesn't double the billed Google calls.
function memoizeDistance(maps: MapsAdapter): MapsAdapter {
  const cache = new Map<string, Promise<DistanceResult | null>>();
  return {
    provider: maps.provider,
    places: (q) => maps.places(q),
    distanceVariants: (from, to) => maps.distanceVariants(from, to),
    distance(from, to) {
      const key = `${from}|${to}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = maps.distance(from, to);
        cache.set(key, hit);
      }
      return hit;
    },
  };
}

// What the booking stores, resolved engine-first (GL-3): the engine price wins whenever it
// can price; otherwise the server's own placeholder quote — the customer's quotedTotal is
// never adopted as the charge when the engine can't price it (see resolveTotals below).
// Customer bookings currently collect the full amount now.
function resolveTotals(
  outcome: PriceOutcome,
  quotedTotal: number | undefined,
  placeholderTotal: number,
): { total: number; amountDueNow: number; mismatch: boolean; unpriced: boolean; reason?: string } {
  if (outcome.priced) {
    const mismatch =
      quotedTotal !== undefined && Math.abs(quotedTotal - outcome.totalCents) > MISMATCH_TOLERANCE_CENTS;
    return { total: outcome.totalCents, amountDueNow: outcome.amountDueNowCents, mismatch, unpriced: false };
  }
  // The client's figure is a display value, not an authority. When the engine cannot price, the
  // server's own placeholder stands and the booking is flagged unpriced — ops sets the real price
  // before it can be paid. Adopting quotedTotal here would let a tampered or merely stale page
  // dictate the charge.
  const total = placeholderTotal;
  return { total, amountDueNow: total, mismatch: false, unpriced: true, reason: outcome.reason };
}

// Customer-safe view of a booking (allow-list). Only display fields + first name — never the
// raw id, channel, or contact details — so a forwarded link reveals nothing the confirmation
// email doesn't already. Driver/fulfilment lives in RideOps (not loaded); margin is on quotes.
export interface CustomerBookingView {
  reference: string;
  status: string;
  mode: 'single' | 'trip' | 'shared';
  firstName: string;
  from: string;
  to: string;
  date: string; // ISO date or 'to confirm' — the trip START
  time: string; // HH:mm or 'to confirm'
  /* The WHOLE journey. `from`/`to` are the endpoints and stay for back-compat, but a trip
     collapsed to its endpoints reads exactly like a direct transfer on the customer card —
     a four-stop tour lost its middle and had no end date to show. `stops` is the full chain
     (always >= 2, so the card can count stops uniformly) and `legDates[i]` is the date the
     leg departing `stops[i]` runs, null where it isn't set yet. */
  stops: string[];
  legDates: (string | null)[]; // always stops.length - 1 entries
  endDate: string; // last known leg date, or 'to confirm'
  travellers: number;
  bags: number | null;
  vehicleType: string | null;
  currency: string;
  totalCents: number;
  amountDueNowCents: number;
  balanceDueCents: number;
}

export function projectBooking(b: Booking): CustomerBookingView {
  const dueNow = b.amountDueNow ?? b.total;
  const base = {
    reference: b.reference,
    status: b.status,
    mode: b.mode,
    firstName: b.input.customer.firstName,
    currency: b.currency,
    totalCents: b.total,
    amountDueNowCents: dueNow,
    balanceDueCents: Math.max(0, b.total - dueNow),
  };
  if (b.mode === 'single') {
    return {
      ...base,
      from: b.input.from,
      to: b.input.to,
      date: b.input.date ?? 'to confirm',
      time: b.input.time ?? 'to confirm',
      // A direct transfer IS a two-stop journey; saying so lets the card use one code path.
      stops: [b.input.from, b.input.to],
      legDates: [b.input.date ?? null],
      endDate: b.input.date ?? 'to confirm',
      travellers: b.input.adults + b.input.children,
      bags: b.input.bags,
      vehicleType: b.input.vehicleType,
    };
  }
  if (b.mode === 'trip') {
    const stops = b.input.stops;
    // One entry per LEG, padded with nulls: a partly-dated trip must still line up with the
    // chain, or the card would silently pair a date with the wrong leg.
    const legDates = Array.from({ length: Math.max(0, stops.length - 1) },
      (_, i) => b.input.dates?.[i] ?? null);
    const known = legDates.filter((d): d is string => !!d);
    return {
      ...base,
      from: stops[0],
      to: stops[stops.length - 1],
      date: b.input.dates?.[0] ?? 'to confirm',
      time: 'to confirm',
      stops,
      legDates,
      endDate: known.length ? known[known.length - 1] : 'to confirm',
      travellers: b.input.pax,
      bags: null,
      vehicleType: b.input.vehicleType,
    };
  }
  // Shared (corridor) bookings store only a corridorId — not from/to strings — and the
  // repo that resolves corridor names (DepartureRepo) isn't loaded here, so the
  // customer-safe view surfaces the fixed pickup/drop-off wording used elsewhere for
  // unresolved fields, plus the date/time the customer picked (SharedInput has both).
  return {
    ...base,
    from: 'Pickup',
    to: 'Drop-off',
    date: b.input.date,
    time: b.input.time,
    stops: ['Pickup', 'Drop-off'],
    legDates: [b.input.date ?? null],
    endDate: b.input.date ?? 'to confirm',
    travellers: b.input.seats,
    bags: null,
    vehicleType: null,
  };
}

export function bookingRoutes(deps: {
  bookings: BookingRepo;
  payments: PaymentRepo;
  adapter: PaymentAdapter;
  departures: DepartureRepo;
  maps: MapsAdapter;
  conciergeTasks: ConciergeTaskRepo;
  quotes?: QuoteRepo; // optional: enables rate-lock (pricing a booking against a web quote's card)
  zones?: ZonesRepo;
  linkSecret: string;
  checkoutNow?: () => number;
  allowLegacyCheckoutWithoutToken?: boolean;
  /**
   * Origin the customer pay page is served from. Only used to build the redirect checkout's
   * return leg; unset simply means a pay-link checkout keeps the adapter's default URLs.
   */
  payBaseUrl?: string;
}) {
  const { bookings, payments, adapter, departures, maps, conciergeTasks, quotes } = deps;
  const zonesRepo = deps.zones ?? new InMemoryZonesRepo();
  const r = new Hono();
  const checkoutNow = deps.checkoutNow ?? Date.now;

  function withCheckoutToken(booking: Booking) {
    return {
      ...booking,
      checkoutToken: signCheckoutToken(booking.id, deps.linkSecret, checkoutNow()),
    };
  }

  function bearerToken(authorization: string | undefined): string | undefined {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const token = authorization.slice(7);
    return token || undefined;
  }

  // Rate-lock (spec 2026-07-11 §4): the card a booking should be priced against. A quoteId from a
  // customer web quote (POST /quote/lock) still inside its 7-day window → that quote's frozen card;
  // an unknown/expired id, or no quotes repo wired → the live card (base rate card composed with
  // currently-active hot zones, hot-zones spec D5). Never throws (a bad id must not fail the
  // booking — it just falls back to the current card). A pricing_zones lookup failure is part of
  // that contract too: it prices unboosted off the plain compiled RATE_CARD rather than failing
  // the booking — any resulting drift from the zone-boosted price is caught by the mismatch flag.
  async function bookingRateCard(quoteId: string | undefined): Promise<RateCard> {
    let current: RateCard;
    try {
      current = await liveRateCard(zonesRepo);
    } catch {
      current = RATE_CARD;
    }
    // Short-circuit before the try: an unwired `quotes` repo or a missing quoteId both mean
    // "just use the live card" — no need to let `.get()` throw to get there.
    if (!quoteId || !quotes) return current;
    try {
      const q = await quotes.get(quoteId);
      if (!q || q.channel !== 'web') return current;
      return rateCardFor(
        { rateCardJson: (q.rateCardJson ?? null) as RateCard | null, rateLockedUntil: q.rateLockedUntil },
        new Date(),
        current,
      ).rateCard;
    } catch {
      return current;
    }
  }

  // Flag a booking for ops as a follow_up task. Best-effort: the booking is already
  // created, so a task hiccup must never fail the request.
  async function flagForOps(booking: Booking, note: string): Promise<void> {
    try {
      await conciergeTasks.create({ bookingId: booking.id, type: 'follow_up', note });
    } catch (err) {
      console.error(`concierge task failed for ${booking.reference}:`, err);
    }
  }

  async function flagPricing(
    booking: Booking,
    resolved: { mismatch: boolean; unpriced: boolean; total: number; reason?: string },
    quotedTotal: number | undefined,
  ): Promise<void> {
    if (resolved.mismatch) {
      await flagForOps(
        booking,
        `price mismatch ${booking.reference}: site quoted ${quotedTotal}¢, engine priced ${resolved.total}¢`,
      );
    } else if (resolved.unpriced) {
      // Say WHY: "distance unresolved" is wrong when the route is fine and Google was simply
      // down, and it would send ops hunting for a bad place name that isn't there.
      await flagForOps(booking, resolved.reason ? `${UNPRICED_NOTE_PREFIX} (${resolved.reason})` : UNPRICED_NOTE);
    }
  }

// Terms + cancellation acceptance (2026-08-01). The website checkbox was client-side ONLY and
// recorded nothing, so a refund dispute had no evidence either way — the same gap the quote
// pay-link path had. Read off the raw body rather than the domain input schemas, which are
// shared with the ops/quote-conversion paths that have their own acceptance story.
// RECORDED, not required. Requiring it here would be a breaking contract change on routes
// with many existing callers, and the value asked for is the evidence, not the gate: booking.js
// always sends it and the wizard already blocks submission without the tick. The quote pay
// path DOES hard-gate — that endpoint was new, so requiring it there cost nothing.
// Deliberately NOT applied to /shared: terms.html §7 defines no cancellation rule for a
// shared seat, so there is nothing there for a customer to accept yet (docs/known-bugs.md).
function termsAcceptedAt(body: unknown): Date | undefined {
  return (body as { termsAccepted?: unknown } | null)?.termsAccepted === true ? new Date() : undefined;
}

// Billing details for the card, read off the raw body for the same reason as the terms above.
// Optional — an older cached booking.js sends none, and PayHere then collects them in its own
// step. But a billing object that IS sent must be complete: `BillingInput` requires
// address/city/country together, because a half-filled one is how the adapter ends up
// forwarding a city with no street, which is worse for the issuer's risk check than sending
// nothing at all. Invalid => 400 at the door rather than a partial address banked on the row.
type BillingParse =
  | { ok: true; billing: BillingInput | undefined }
  | { ok: false };

function billingFrom(body: unknown): BillingParse {
  const raw = (body as { billing?: unknown } | null)?.billing;
  if (raw === undefined || raw === null) return { ok: true, billing: undefined };
  const parsed = BillingInput.safeParse(raw);
  return parsed.success ? { ok: true, billing: parsed.data } : { ok: false };
}

  // 1.4 — create a single-transfer draft. Idempotent on the Idempotency-Key header.
  r.post('/single', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SingleTransferInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const billing = billingFrom(body);
    if (!billing.ok) return c.json({ error: 'invalid_billing' }, 400);
    // No past dates — a trip can't be booked for a day that has already passed (Asia/Colombo).
    if (isPastIsoDate(parsed.data.date, isoToday())) {
      return c.json({ error: 'date_in_past', message: 'Trip dates cannot be in the past.' }, 400);
    }
    // Minimum notice — a driver and vehicle have to be assigned before the pickup.
    if (isTooSoonPrivate(parsed.data.date, parsed.data.time)) {
      return c.json({ error: 'lead_time_too_short', message: PRIVATE_NOTICE_MESSAGE }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(withCheckoutToken(existing), 200);
    }

    // The engine is the pricing truth; a client quotedTotal is never adopted — an unpriced
    // booking takes the server placeholder and is flagged for ops.
    const legMaps = memoizeDistance(maps);
    const rateCard = await bookingRateCard(parsed.data.quoteId);
    let outcome;
    try {
      outcome = await priceSingle(parsed.data, legMaps, rateCard);
    } catch (err) {
      if (err instanceof InvalidPricingRequestError) return c.json({ error: err.code }, 422);
      throw err;
    }
    const resolved = resolveTotals(outcome, parsed.data.quotedTotal, quoteSingleTransfer(parsed.data).total);
    // M8 — enrich with road distance/duration (best-effort; never blocks the booking).
    let distance = null;
    try {
      distance = await legMaps.distance(parsed.data.from, parsed.data.to);
    } catch {
      distance = null;
    }
    const booking = await bookings.create(
      {
        mode: 'single',
        input: parsed.data,
        total: resolved.total,
        amountDueNow: resolved.amountDueNow,
        needsPricing: resolved.unpriced,
        currency: 'USD',
        distanceKm: distance?.km ?? null,
        durationMin: distance?.durationMin ?? null,
        billing: billing.billing, // what the card gateway is handed; absent => PayHere collects it
        termsAcceptedAt: termsAcceptedAt(body), // evidence for a refund dispute; absent = never recorded
      },
      { idempotencyKey: key },
    );
    await flagPricing(booking, resolved, parsed.data.quotedTotal);
    return c.json(withCheckoutToken(booking), 201);
  });

  // 9.4 — create a multi-stop trip draft (planner / tour hand-off). Same idempotency
  // and pipeline as a single transfer; only the input shape and pricing differ.
  r.post('/trip', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = TripInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const billing = billingFrom(body);
    if (!billing.ok) return c.json({ error: 'invalid_billing' }, 400);
    // No past dates — reject if any leg date has already passed (Asia/Colombo).
    if (firstPastDate(parsed.data.dates ?? [], isoToday())) {
      return c.json({ error: 'date_in_past', message: 'Trip dates cannot be in the past.' }, 400);
    }
    // Minimum notice. A chauffeur-guide holds one car and driver for the whole journey, so it
    // needs far more warning than a private transfer — the trip's start date is what binds.
    const tripDates = parsed.data.dates ?? [];
    if (parsed.data.serviceType === 'chauffeur') {
      if (isTooSoonChauffeur(tripDates)) {
        return c.json({ error: 'lead_time_too_short', message: CHAUFFEUR_NOTICE_MESSAGE }, 400);
      }
    } else if (tripDates.some((d) => isTooSoonPrivate(d, undefined))) {
      // Trip legs carry no time of day, so a private trip is judged on the calendar floor alone.
      return c.json({ error: 'lead_time_too_short', message: PRIVATE_NOTICE_MESSAGE }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(withCheckoutToken(existing), 200);
    }

    // Engine-first; customer bookings currently collect the full amount now.
    const legMaps = memoizeDistance(maps);
    const rateCard = await bookingRateCard(parsed.data.quoteId);
    let outcome;
    try {
      outcome = await priceTrip(parsed.data, legMaps, rateCard);
    } catch (err) {
      if (err instanceof InvalidPricingRequestError) return c.json({ error: err.code }, 422);
      throw err;
    }
    const resolved = resolveTotals(
      outcome,
      parsed.data.quotedTotal,
      quoteTrip(parsed.data).total,
    );
    // M8 — total road distance/duration across the trip's legs (best-effort; null if any
    // leg can't be resolved, since a partial sum would understate the trip).
    const stops = parsed.data.stops;
    let tripKm: number | null = 0;
    let tripMin: number | null = 0;
    try {
      for (let i = 0; i < stops.length - 1; i++) {
        const leg = await legMaps.distance(stops[i], stops[i + 1]);
        if (!leg) {
          tripKm = null;
          tripMin = null;
          break;
        }
        tripKm += leg.km;
        tripMin += leg.durationMin;
      }
    } catch {
      tripKm = null;
      tripMin = null;
    }
    const booking = await bookings.create(
      {
        mode: 'trip',
        input: parsed.data,
        total: resolved.total,
        amountDueNow: resolved.amountDueNow,
        needsPricing: resolved.unpriced,
        currency: 'USD',
        distanceKm: tripKm === null ? null : Math.round(tripKm),
        durationMin: tripMin === null ? null : Math.round(tripMin),
        billing: billing.billing, // what the card gateway is handed; absent => PayHere collects it
        termsAcceptedAt: termsAcceptedAt(body), // evidence for a refund dispute; absent = never recorded
      },
      { idempotencyKey: key },
    );
    await flagPricing(booking, resolved, parsed.data.quotedTotal);
    return c.json(withCheckoutToken(booking), 201);
  });

  // 10.4 — book a shared seat. Resolve the corridor, price by seats, atomically hold the
  // seats on the departure (409 if sold out), then create the booking.
  r.post('/shared', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SharedBookingRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const billing = billingFrom(body);
    if (!billing.ok) return c.json({ error: 'invalid_billing' }, 400);
    const req = parsed.data;
    // No past dates — a seat can't be booked for a departure that has already passed.
    if (isPastIsoDate(req.date, isoToday())) {
      return c.json({ error: 'date_in_past', message: 'Trip dates cannot be in the past.' }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(withCheckoutToken(existing), 200);
    }

    // The catalogue decides what is sellable, not corridor adjacency. A corridor holds
    // several products at different prices (airport-cultural sells Negombo->Sigiriya at
    // $27.49 and Sigiriya->Kandy at $19.99), so `corridorId` alone cannot identify a
    // booking and `corridor.seatPrice` cannot price one.
    const product = req.from && req.to ? sharedProductFor(req.from, req.to) : null;
    if (!product) {
      return c.json(
        {
          error: 'not_a_shared_route',
          message:
            'We don’t run a scheduled shared seat on that route. Book it as a private transfer, or start a ride-board list and we’ll run a van once enough travellers join.',
        },
        400,
      );
    }
    const corridor = await departures.getCorridor(product.corridorId);
    if (!corridor) return c.json({ error: 'unknown_corridor' }, 400);

    // Shared seats run a fixed weekly schedule — reject a date that isn't one of the
    // corridor's service weekdays (the website greys these out; enforce it server-side too).
    // Checked before holding a seat so an off-schedule request never touches inventory.
    const dow = isoWeekday(req.date);
    if (dow !== null && !corridor.serviceDays.includes(dow)) {
      const label = serviceDaysLabel(corridor.serviceDays);
      return c.json(
        {
          error: 'not_a_service_day',
          message: `This shared route only departs on ${label}. Pick one of those days, or book it as a private transfer.`,
        },
        400,
      );
    }

    // Seat inventory is keyed on the departure time, and an unrecognised time creates a fresh
    // full-capacity departure — so an arbitrary string sells the same van again. The real
    // departure is the PRODUCT's boarding time at this stop: a corridor's own time is when
    // the van leaves its first stop, which is wrong for every stop after it (Sigiriya→Kandy
    // boards at 11:30 on a corridor whose van leaves CMB at 07:00).
    const time = req.time.trim();
    if (time !== product.time) {
      return c.json(
        {
          error: 'unknown_departure_time',
          message: `This shared route departs at ${product.time}${product.pickup ? ` from ${product.pickup}` : ''}. Pick that time, or book it as a private transfer.`,
        },
        400,
      );
    }

    const held = await departures.holdSeats({
      corridorId: corridor.id,
      date: req.date,
      time,
      seats: req.seats,
    });
    if (!held) return c.json({ error: 'sold_out' }, 409);

    // GL-3 — the catalogue price is authoritative; the client's quotedTotal is never
    // stored, only compared and flagged when it disagrees.
    const { currency, totalCents: total, amountDueNowCents: amountDueNow } = priceShared(
      req.seats,
      product.seatPrice,
      req.bags ?? 0,
    );
    const input = {
      corridorId: corridor.id,
      date: req.date,
      time: req.time,
      seats: req.seats,
      customer: req.customer,
    };
    let booking;
    try {
      booking = await bookings.create(
        { mode: 'shared', input, total, amountDueNow, currency, billing: billing.billing },
        { idempotencyKey: key },
      );
    } catch (err) {
      // Compensate the hold so a failed create doesn't strand seats on the departure
      // (sweepStaleSharedHolds only reclaims holds that have a booking row).
      await departures.releaseSeats({ corridorId: corridor.id, date: req.date, time: req.time, seats: req.seats });
      throw err;
    }
    if (req.quotedTotal !== undefined && Math.abs(req.quotedTotal - total) > MISMATCH_TOLERANCE_CENTS) {
      await flagForOps(
        booking,
        `price mismatch ${booking.reference}: site quoted ${req.quotedTotal}¢, engine priced ${total}¢`,
      );
    }
    return c.json(withCheckoutToken(booking), 201);
  });

  // The return leg of a redirect checkout (spec: docs/checkout-redirect-spec.md §D5/§D6).
  //
  // PayHere documents that NO payment status is passed back on the redirect — "You need to
  // update your database upon fetching payment status by your script on notify_url & then show
  // the payment status to your customer in the page on return_url by fetching the status from
  // your database." So this answers from OUR settlement state, which the webhook owns, and the
  // returning page polls it. Nothing the browser arrives holding is trusted as a status.
  //
  // Three outcomes, because a decline must never read as an endless "confirming…": `paid` once
  // the money is in, `failed` when the attempt reached a terminal refusal, `pending` while the
  // webhook has not landed yet — which is also, correctly, the answer before any attempt.
  //
  // Deliberately returns TWO fields. The token authorises reading a settlement status, so that
  // is all it may read: no customer details, no itinerary, no amounts. The reference is included
  // because the page shows it and the customer already has it in their email and their link.
  r.get('/pay-return', async (c) => {
    const id = verifyPayReturnToken(c.req.query('rt'), deps.linkSecret);
    if (!id) return c.json({ error: 'invalid_link' }, 401);
    const booking = await deps.bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    const rows = await payments.findByBookingId(booking.id);
    // A settled payment is the answer whatever else is on the booking — including the ops
    // lifecycle mirror having moved it on. Only then a terminal failure; anything else is
    // still in flight.
    const status = rows.some((p) => p.status === 'succeeded')
      ? 'paid'
      : rows.some((p) => p.status === 'failed')
        ? 'failed'
        : 'pending';
    return c.json({ status, reference: booking.reference }, 200);
  });

  // 1.5 — view a booking via a signed capability token (customer-facing #2). Replaces the
  // old unauthenticated GET /:id (nothing calls it: the site uses POST /:id/checkout and
  // internal callers use the repo). Returns only a customer-safe projection.
  r.get('/view', async (c) => {
    const id = verifyBookingToken(c.req.query('t'), deps.linkSecret);
    if (!id) return c.json({ error: 'invalid_link' }, 401);
    const booking = await deps.bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    return c.json(projectBooking(booking), 200);
  });

  r.post('/view/checkout-token', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const id = verifyBookingToken(token, deps.linkSecret);
    if (!id) return c.json({ error: 'invalid_link' }, 401);
    const booking = await bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    if (
      (booking.status !== 'draft' && booking.status !== 'payment_pending') ||
      booking.needsPricing
    ) {
      return c.json({ error: 'not_chargeable', status: booking.status }, 409);
    }
    // bookingId rides along because POST /bookings/:id/checkout needs it in the path and the
    // customer-safe view projection deliberately withholds it. The caller has already proved
    // it holds a valid link token for exactly this booking, so this tells it nothing new —
    // and without it the manage page cannot complete a payment it is authorised to start.
    return c.json(
      {
        checkoutToken: signCheckoutToken(booking.id, deps.linkSecret, checkoutNow()),
        bookingId: booking.id,
      },
      200,
    );
  });

  // 5.2 — start payment. Creates a pending payment (idempotent per booking), moves the
  // booking to payment_pending, and returns checkout params. The checkout amount must
  // equal what the booking says is due now (currently the full total; pre-GL-3 rows
  // have no amountDueNow and are charged the total) — never present a
  // charge that disagrees with the booking.
  r.post('/:id/checkout', async (c) => {
    const id = c.req.param('id');
    const authorization = c.req.header('authorization');
    const token = bearerToken(authorization);
    const legacyAllowed = !authorization && deps.allowLegacyCheckoutWithoutToken === true;
    if (!legacyAllowed && !verifyCheckoutToken(token, id, deps.linkSecret, checkoutNow())) {
      return c.json({ error: 'checkout_unauthorized' }, 401);
    }
    const booking = await bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    // Only a fresh (draft) or in-progress (payment_pending) booking may be charged. A
    // cancelled, paid, or otherwise-progressed booking must NEVER be handed a live PayHere
    // form — that is how a customer ends up paying for a trip that no longer exists.
    if (booking.status !== 'draft' && booking.status !== 'payment_pending') {
      return c.json({ error: 'not_chargeable', status: booking.status }, 409);
    }
    // The engine could not price this, so `total` is a flat placeholder rather than a quote.
    // Charging it is how a $125 transfer was sold for $40, and how a Google outage would sell a
    // $123.50 route for $78. A concierge task was raised at create time; ops prices it by hand.
    if (booking.needsPricing) {
      return c.json(
        {
          error: 'awaiting_price',
          message: "We're confirming the price for this trip by hand — we'll message you shortly with the final amount.",
        },
        409,
      );
    }
    const dueNow = booking.amountDueNow ?? booking.total;

    const idempotencyKey = `checkout:${booking.id}`;
    let payment = await payments.findByIdempotencyKey(idempotencyKey);
    // Defence in depth: if the payment already settled, refuse a second checkout even if the
    // booking somehow lags in a chargeable status.
    if (payment && payment.status === 'succeeded') {
      return c.json({ error: 'already_paid', status: booking.status }, 409);
    }
    if (!payment) {
      payment = await payments.create({
        bookingId: booking.id,
        provider: adapter.provider,
        orderId: booking.reference,
        amount: dueNow,
        currency: booking.currency,
        idempotencyKey,
      });
      if (booking.status === 'draft') await bookings.setStatus(booking.id, 'payment_pending');
    }

    // Where the gateway sends the customer back to (spec: docs/checkout-redirect-spec.md §D3).
    // A pay-link customer must land on the PAY page; the adapter's constructor URLs point at
    // booking.html, which is the website checkout's own page and pure confusion for this payer.
    //
    // The client states INTENT ONLY — it never supplies a URL. A gateway that will redirect the
    // customer wherever the request body says is a phishing primitive, and the request that
    // reaches here has already crossed the network. So the origin comes from our own config and
    // the token is minted here, over the booking this checkout is actually for.
    const body = (await c.req.json().catch(() => null)) as { returnTo?: unknown } | null;
    const returnUrls =
      body?.returnTo === 'pay-link' && deps.payBaseUrl
        ? (() => {
            const rt = signPayReturnToken(booking.id, deps.linkSecret);
            const base = `${deps.payBaseUrl.replace(/\/$/, '')}/pay.html?rt=${encodeURIComponent(rt)}`;
            // Both legs land on the SAME page. PayHere documents return_url for an approved
            // payment and cancel_url for a customer-cancelled one, but says nothing about where
            // a DECLINED payment goes — so neither URL may be the only one that works. The page
            // polls our own settlement state either way; `c=1` is a display hint, never truth.
            return { returnUrl: base, cancelUrl: `${base}&c=1` };
          })()
        : {};

    const cust = booking.input.customer;
    const params = await adapter.createCheckout({
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
      ...returnUrls,
      // What the payer sees named on the PayHere receipt. "Ceylon Hop Travel" rather than
      // "Ceylon Hop" so an unfamiliar line is self-explaining, and the reference so a query
      // about a charge arrives with the booking already identified.
      //
      // This is NOT the bank-statement descriptor, however much it looks like one. PayHere's
      // Checkout API has no descriptor parameter at all — the statement text comes from the
      // acquirer/merchant account and can only be changed by asking PayHere.
      items: `Ceylon Hop Travel - ${booking.reference}`,
      customer: {
        // The gateway's fields are BILLING fields, so the cardholder's name wins when the
        // payer told us they differ from the lead passenger. Email/phone stay the lead
        // passenger's: that is who gets the receipt and the driver's details.
        firstName: booking.billing?.firstName || cust.firstName,
        // PayHere itself substitutes '-' for a missing surname (adapters/payhere.ts), so an
        // empty string here is carried, not invented.
        lastName: booking.billing?.lastName || cust.lastName || '',
        email: cust.email,
        phone: cust.whatsapp,
        // Billing country when we have one; otherwise the lead passenger's, which is what
        // this has always been (derived from their phone country code).
        country: booking.billing?.country || cust.country,
        address: booking.billing?.address,
        city: booking.billing?.city,
        postcode: booking.billing?.postcode,
        state: booking.billing?.state,
      },
    });
    if (params.amount !== dueNow) {
      return c.json({ error: 'amount_mismatch' }, 409);
    }
    // The PayHere popup callback only means the hosted checkout finished. The browser must
    // still ask our server whether the webhook settled this booking before it can say
    // "booked". This purpose-scoped token exposes no booking data and cannot authorize a
    // second checkout; it is accepted only by GET /bookings/pay-return.
    return c.json(
      { ...params, payReturnToken: signPayReturnToken(booking.id, deps.linkSecret) },
      200,
    );
  });

  return r;
}
