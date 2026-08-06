// The margin-safe view-model of a trip (spec 2026-08-05 D10). ONE projection, three consumers:
// the quote page, the pay page, and sendCustomerQuote's parked send-wiring — so the three
// surfaces cannot drift in how they describe the same trip.
//
// Pure over (quote, services): no repo, no clock, no request. The caller supplies both service
// totals because pricing them is the route's job (serviceChooserData against the LOCKED card);
// this file only decides what a customer is told.
//
// HAND-PICKED on purpose. The stored quote carries marginCents, the locked rate card (cost and
// markup) and hot-zone annotations; nothing here may echo `result`, `request` or `rateCardJson`.
import { payPageCopy } from './payPageCopy';
import { quoteDays, type QuoteDayRow } from './quoteDays';

export interface QuoteViewOption {
  service: 'private' | 'chauffeur';
  name: string;
  blurb: string;
  includedText: string;
  totalCents: number;
  totalUsd: string;
  deltaUsd: string | null;
  deltaText: string | null;
  cancellation: { headline: string; ladder: string[] };
  lead: boolean;
  waText: string;
}

export interface CustomerQuoteView {
  reference: string;
  greetingName: string | null;
  title: string;
  subtitle: string;
  heroTotalUsd: string;
  heroTotalNote: string;
  days: QuoteDayRow[];
  mapStops: string[];
  totalKm: number | null;
  travelDays: number;
  options: QuoteViewOption[];
  waText: string;
}

interface ViewQuote {
  reference: string;
  customerName: string | null;
  vehicle: string | null;
  totalCents: number;
  requestedService?: string | null;
  request: unknown;
}

interface ToolLegLite {
  from?: string; to?: string; date?: string; category?: string; distanceKm?: number; stops?: string[];
}

// '$840' / '$1,180' — whole dollars with a thousands separator. Quote totals are charm-finished
// to round figures; cents on a proposal would read as a bill, not an offer.
const usd = (cents: number): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

// terms.html §7. The two ladders genuinely differ, and a customer comparing two totals is
// comparing two different commitments — so each option carries its own.
const CANCELLATION = {
  private: {
    headline: 'Free cancellation up to 24 hours before',
    ladder: ['More than 24 h before pickup: full refund', 'Inside 24 h: 50% refund', 'No-show: no refund'],
  },
  chauffeur: {
    headline: 'Free cancellation up to 10 days before',
    ladder: ['More than 10 days before: full refund', 'Inside 10 days: up to 80% refund'],
  },
} as const;

const COPY = {
  private: {
    name: 'Private transfers',
    blurb: 'A car and driver for each journey. Between them, your time is your own.',
    included: 'Air-conditioned car with an English-speaking driver · fuel, tolls and parking · every pickup at your door.',
  },
  chauffeur: {
    name: 'Chauffeur & guide',
    blurb: "The same car and driver stay with you for the whole trip, including the days you're not moving.",
    included: "Vehicle & English-speaking driver for the whole trip · fuel and tolls · driver's meals and accommodation.",
  },
} as const;

// The phrase describing what the SECONDARY option actually is — used in the hero note. Must
// derive from that option's own service, not assume it is always chauffeur: when ops priced
// chauffeur and private is the cheaper alternative, "with your driver throughout" would
// misdescribe the point-to-point option, and this is customer-facing copy about money.
const SECONDARY_PHRASE: Record<'private' | 'chauffeur', string> = {
  chauffeur: 'with your driver throughout',
  private: 'travelling journey by journey',
};

function legsOf(quote: ViewQuote): ToolLegLite[] {
  const req = (quote.request ?? {}) as { tool?: { legs?: ToolLegLite[] } };
  return Array.isArray(req.tool?.legs) ? req.tool!.legs! : [];
}

const drives = (l: ToolLegLite) => (l.category || 'transfer') !== 'stay_day';

// The ordered stop list CH_MAP.renderRoute() draws: every stop in sequence, de-duplicated where
// one leg ends where the next begins, so a 5-stop trip renders 5 pins and not 8.
function mapStopsOf(quote: ViewQuote): string[] {
  const out: string[] = [];
  for (const l of legsOf(quote).filter(drives)) {
    const chain = Array.isArray(l.stops) && l.stops.length >= 2 ? l.stops : [l.from ?? '', l.to ?? ''];
    for (const s of chain) {
      if (s && s !== out[out.length - 1]) out.push(s);
    }
  }
  return out;
}

export function customerQuoteView(
  quote: ViewQuote,
  services: { pointToPoint: { totalCents: number } | null; chauffeur: { totalCents: number } | null },
): CustomerQuoteView {
  const copy = payPageCopy(quote);
  const engine = ((quote.request ?? {}) as { engine?: { product?: string } | null }).engine ?? null;
  const priced: 'private' | 'chauffeur' = engine?.product === 'chauffeur' ? 'chauffeur' : 'private';

  // requestedService decides how many options a customer sees (spec D7). Anything other than
  // 'both' — including null on a legacy row — shows the one service that was priced.
  const wantsBoth = quote.requestedService === 'both';
  const other: 'private' | 'chauffeur' = priced === 'private' ? 'chauffeur' : 'private';
  const totalFor = (s: 'private' | 'chauffeur') =>
    (s === 'chauffeur' ? services.chauffeur : services.pointToPoint)?.totalCents ?? null;

  // The priced service always falls back to the STORED total: it is the number that was
  // approved, and a recompute must never quietly outrank it.
  const pricedTotal = totalFor(priced) ?? quote.totalCents;
  const otherTotal = wantsBoth ? totalFor(other) : null;

  const waFor = (label: string | null) =>
    label
      ? `Hi! I'd like to book the ${label} option for quote ${quote.reference}`
      : `Hi! I have a question about quote ${quote.reference}`;

  const build = (service: 'private' | 'chauffeur', cents: number, lead: boolean): QuoteViewOption => {
    const c = COPY[service];
    const diff = lead ? null : cents - pricedTotal;
    return {
      service,
      name: c.name,
      blurb: c.blurb,
      // The priced option reuses payPageCopy's own inclusion sentence, so the quote page and the
      // pay page describe the same purchase in the same words.
      includedText: lead ? copy.includedText : c.included,
      totalCents: cents,
      totalUsd: usd(cents),
      deltaUsd: diff == null || diff <= 0 ? null : `+${usd(diff)}`,
      deltaText:
        diff == null || diff <= 0
          ? null
          : `+${usd(diff)} — ${service === 'chauffeur' ? 'your driver stays with you throughout' : 'you travel journey by journey'}`,
      cancellation: { headline: CANCELLATION[service].headline, ladder: [...CANCELLATION[service].ladder] },
      lead,
      waText: waFor(c.name),
    };
  };

  const options: QuoteViewOption[] = [build(priced, pricedTotal, true)];
  if (otherTotal != null) options.push(build(other, otherTotal, false));

  const driving = legsOf(quote).filter(drives);
  const kms = driving.map((l) => (typeof l.distanceKm === 'number' ? l.distanceKm : 0));
  const totalKm = kms.some((k) => k > 0) ? Math.round(kms.reduce((a, b) => a + b, 0)) : null;

  // The secondary option's OWN service decides the phrasing — not a hardcoded "with your driver
  // throughout" that only holds when the secondary happens to be chauffeur (correction, task 3).
  const secondary = options[1];
  const heroTotalNote = secondary
    ? `${options[0].name.toLowerCase()} · or ${secondary.totalUsd} ${SECONDARY_PHRASE[secondary.service]}`
    : `all-in · ${options[0].name.toLowerCase()}`;

  return {
    reference: quote.reference,
    greetingName: copy.greetingName,
    title: copy.title,
    subtitle: copy.subtitle,
    heroTotalUsd: usd(pricedTotal),
    heroTotalNote,
    days: quoteDays(quote),
    mapStops: mapStopsOf(quote),
    totalKm,
    travelDays: driving.length,
    options,
    waText: waFor(null),
  };
}
