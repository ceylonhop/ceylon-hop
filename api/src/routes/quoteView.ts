import { Hono } from 'hono';
import type { QuoteRepo, SavedQuote } from '../db/quoteRepo';
import type { BookingRepo } from '../db/bookingRepo';
import { verifyQuoteViewToken, signBookingToken } from '../lib/bookingToken';
import { customerQuoteView } from '../quote/customerQuoteView';
import { rateCardFor } from '../quote/rateLock';
import { quote as priceQuote } from '../quote/engine';
import type { QuoteRequest, PrivateLeg, Ride, ChauffeurTravelDay, ChauffeurRideDay } from '../quote/types';
import type { RateCard } from '../quote/rateCard';

// The customer half of quote links (spec 2026-08-05). ONE route, and it READS — this module has
// no POST and touches no repo mutation, which is what makes a forwarded quote link harmless.
// Two invariants dominate the file:
//
//   1. MARGIN NEVER REACHES THE WIRE. The stored quote carries marginCents, the locked rate card
//      (cost + markup) and hot-zone annotations. The response is built from customerQuoteView's
//      hand-picked projection; `result`, `request` and `rateCardJson` are never echoed.
//
//   2. THE LINK FOLLOWS THE QUOTE. The token pins nothing, so an edit updates this page rather
//      than killing it. Liveness comes from the quote's STATUS (D8), which also gives ops an
//      instant kill switch a timer could not.

type ViewState = 'live' | 'lapsed' | 'booked' | 'unavailable';

// The stored `request.tool` payload, narrowed to the one field this route actually needs: each
// leg's date (chauffeur eligibility is a date-count check) and category (to tell a stay day from
// a driving leg). NOT the full ToolRequest from internalQuote.ts — that type is private to that
// route file, and this route is scoped to quoteView.ts/app.ts only, so the shape is duplicated
// rather than exported. Keep it in lockstep with internalQuote.ts's ToolLegSchema if that changes.
interface StoredToolLeg {
  date?: string;
  category?: 'transfer' | 'airport' | 'train_support' | 'stay_day';
}

const drivesLeg = (l: StoredToolLeg): boolean => (l.category ?? 'transfer') !== 'stay_day';

// Reconstruct the CHAUFFEUR pricing request from a stored PRIVATE engine request, using the tool
// payload's leg dates. This is the inverse of internalQuote.ts's toEngineRequest: a chauffeur
// travel day IS a private leg plus a date, both built from the very same `tool.legs.filter(drives)`
// array — so zipping the private engine's legs with the driving tool legs' dates, positionally,
// reproduces exactly what toEngineRequest(tool, 'chauffeur') would have produced.
//
// Mirrors serviceChooserData's eligibility gate too (internalQuote.ts, search
// `function serviceChooserData`): every leg — including stay days, which the private engine
// request has already dropped — must carry a date, and the trip must span more than one distinct
// date. Anything short of that returns null, same as ops's "not offerable" state, so the page
// renders one option rather than a broken second card.
function chauffeurFromPrivate(
  engine: Extract<QuoteRequest, { product: 'private' }>,
  toolLegs: StoredToolLeg[] | undefined,
): QuoteRequest | null {
  if (!toolLegs || toolLegs.length === 0) return null;
  if (toolLegs.some((l) => !l.date)) return null; // "add a date to every leg"
  const dates = toolLegs.map((l) => l.date as string);
  if (new Set(dates).size <= 1) return null; // single-day — point-to-point only
  const drivingDates = toolLegs.filter(drivesLeg).map((l) => l.date as string);
  if (drivingDates.length !== engine.legs.length) return null; // stored shapes disagree — degrade, don't guess
  const sorted = [...dates].sort();
  return {
    product: 'chauffeur',
    vehicle: engine.vehicle,
    firstDate: sorted[0],
    lastDate: sorted[sorted.length - 1],
    pax: engine.pax,
    bags: engine.bags,
    travelDays: engine.legs.map((leg, i) => ({ date: drivingDates[i], ...leg })),
    extras: engine.extras,
    customPerKmCents: engine.customPerKmCents,
  };
}

// A travel day is a private leg plus a date — drop the date. Explicit shape-by-shape rather than
// object-rest-destructuring: TS's excess-property check is skipped for non-literal assignments
// either way, but naming both cases keeps this readable as "the leg fields, not the date field".
function stripDate(day: ChauffeurTravelDay | ChauffeurRideDay): PrivateLeg | Ride {
  return 'stops' in day ? { stops: day.stops, segmentKms: day.segmentKms } : { from: day.from, to: day.to, distanceKm: day.distanceKm };
}

// Reconstruct the PRIVATE pricing request from a stored CHAUFFEUR engine request. No tool payload
// needed here: each travel day already IS a private leg plus a date (see chauffeurFromPrivate) —
// dropping the date is the whole operation, and it needs nothing this route can't already see.
function privateFromChauffeur(engine: Extract<QuoteRequest, { product: 'chauffeur' }>): QuoteRequest {
  return {
    product: 'private',
    vehicle: engine.vehicle,
    pax: engine.pax ?? 1,
    bags: engine.bags ?? 0,
    legs: engine.travelDays.map(stripDate),
    extras: engine.extras,
    customPerKmCents: engine.customPerKmCents,
  };
}

// Both services, priced against the card this quote is LOCKED to — the same inputs the ops
// service chooser (internalQuote.ts's serviceChooserData) uses, so the customer can never be
// shown a number ops has not seen. Any failure degrades to "not offerable" rather than 500ing
// in front of a customer.
function servicesFor(quote: SavedQuote, now: Date): {
  pointToPoint: { totalCents: number } | null;
  chauffeur: { totalCents: number } | null;
} {
  const req = quote.request as { engine?: QuoteRequest; tool?: { legs?: StoredToolLeg[] } } | null;
  const engine = req?.engine;
  if (!engine || (engine.product !== 'private' && engine.product !== 'chauffeur')) {
    // Shared-ride quotes (and legacy rows with no engine snapshot) don't go through this
    // page's private/chauffeur comparison at all.
    return { pointToPoint: null, chauffeur: null };
  }
  let card: RateCard;
  try {
    ({ rateCard: card } = rateCardFor(
      { rateCardJson: (quote.rateCardJson ?? null) as RateCard | null, rateLockedUntil: quote.rateLockedUntil },
      now,
    ));
  } catch {
    return { pointToPoint: null, chauffeur: null };
  }
  const price = (r: QuoteRequest | null) => {
    if (!r) return null;
    try {
      return { totalCents: priceQuote(r, card).totalCents };
    } catch {
      return null;
    }
  };

  if (engine.product === 'private') {
    return {
      pointToPoint: price(engine),
      chauffeur: price(chauffeurFromPrivate(engine, req?.tool?.legs)),
    };
  }
  return {
    pointToPoint: price(privateFromChauffeur(engine)),
    chauffeur: price(engine),
  };
}

export function quoteViewRoutes(deps: {
  quotes: QuoteRepo;
  bookings?: BookingRepo;
  linkSecret: string;
  appBaseUrl?: string;
  now?: () => number;
}) {
  const r = new Hono();
  const nowMs = deps.now ?? (() => Date.now());

  r.get('/', async (c) => {
    // Every answer is 200 + no-store. A following link whose response is cached anywhere is a
    // pinned link with extra steps — the exact behaviour this design exists to avoid, failing in
    // the way hardest to notice because it works for whoever tests it first.
    const send = (body: Record<string, unknown>) => c.json(body, 200, { 'cache-control': 'no-store' });

    const parsed = verifyQuoteViewToken(c.req.query('t'), deps.linkSecret);
    if (!parsed) return send({ state: 'unavailable' as ViewState }); // soft — no detail leak
    const quote = await deps.quotes.get(parsed.quoteId);
    if (!quote) return send({ state: 'unavailable' as ViewState });

    const now = new Date(nowMs());

    // Won FIRST: a quote that succeeded must never read as a dead end.
    if (quote.status === 'won') {
      const booking = quote.convertedBookingId && deps.bookings
        ? await deps.bookings.get(quote.convertedBookingId)
        : null;
      return send({
        state: 'booked' as ViewState,
        booked: {
          reference: booking?.reference ?? null,
          firstName: (quote.customerName ?? '').trim().split(/\s+/)[0] || null,
          title: customerQuoteView(quote, servicesFor(quote, now)).title,
          // The keepsake hands the customer to where their booking actually lives.
          manageUrl: booking && deps.appBaseUrl
            ? `${deps.appBaseUrl.replace(/\/$/, '')}/manage.html?t=${signBookingToken(booking.id, deps.linkSecret)}`
            : null,
        },
      });
    }

    if (quote.status !== 'ready' && quote.status !== 'sent') {
      return send({ state: 'unavailable' as ViewState });
    }

    const lapsed = !!quote.offerValidUntil && quote.offerValidUntil.getTime() < now.getTime();
    return send({
      state: (lapsed ? 'lapsed' : 'live') as ViewState,
      view: customerQuoteView(quote, servicesFor(quote, now)),
      validUntil: quote.offerValidUntil ? quote.offerValidUntil.toISOString() : null,
    });
  });

  return r;
}
