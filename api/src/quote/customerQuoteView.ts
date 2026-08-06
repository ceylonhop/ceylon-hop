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

// '$840' / '$1,180' when the total is an exact number of dollars, '$840.37' / '$1,180.37'
// otherwise — always with a thousands separator. priceFinish.ts's 'unchanged' and
// 'nearest_50_cents' strategies can legitimately leave cents on a total (e.g. 84037), and
// rounding those away here would show a lower figure than pay.html's .toFixed(2) actually
// charges — a proposal that understates checkout by up to $0.49.
const usd = (cents: number): string => {
  const dollars = cents / 100;
  const decimals = Number.isInteger(dollars) ? 0 : 2;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

// Must track pay.html's cancellationPolicy(product) exactly (terms.html §7 is the underlying
// authority). The two ladders genuinely differ, and a customer comparing two totals is
// comparing two different commitments — so each option carries its own.
const CANCELLATION = {
  private: {
    headline: 'Free cancellation until 24 hours before departure.',
    ladder: [
      'More than 24 hours before departure: full refund, unlimited changes',
      'Within 24 hours, a no-show, or after departure: no refund',
    ],
  },
  chauffeur: {
    headline: 'Free cancellation until 10 days before your trip starts.',
    ladder: [
      '10–8 days before: 80% refund',
      '7–3 days before: 60% refund',
      '2 days–24 hours before: 40% refund',
      'Within 24 hours, a no-show, or after the trip begins: no refund',
    ],
  },
} as const;

const COPY = {
  private: {
    name: 'Private transfers',
    // Not "your time is your own" — the lead card's included box already ends with that exact
    // sentence (it reuses payPageCopy's wording for pay-page parity), and the two collided on
    // the live page. This line instead carries the differentiator the comparison turns on.
    blurb: "A fresh car and driver for each journey — you only pay for the days you're moving.",
    included: 'Air-conditioned car with an English-speaking driver · fuel, tolls and parking · every pickup at your door.',
  },
  chauffeur: {
    name: 'Chauffeur & guide',
    blurb: "The same car and driver stay with you for the whole trip, including the days you're not moving.",
    // "Everything in X, plus" — pricing-table grammar. The two cards' included boxes used to be
    // near-identical feature lists, so scanning them answered nothing about what the extra money
    // buys; this one now lists only the difference.
    included: "Everything in Private transfers, plus: your driver stays between journeys · sightseeing stops on the way · driver's meals & rooms covered.",
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

// Whole-trip span in days, first to last leg date inclusive — the denominator for the delta's
// per-day reframing. null when any needed date is missing; the per-day line simply doesn't
// render then, rather than being invented.
function tripSpanDays(quote: ViewQuote): number | null {
  const times = legsOf(quote)
    .map((l) => Date.parse(String(l.date ?? '').slice(0, 10) + 'T00:00:00Z'))
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  const days = Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000) + 1;
  return days >= 1 ? days : null;
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
  // THE STORED TOTAL WINS for the service that was priced — never the recompute.
  //
  // What this page shows must equal what the pay link charges, and the pay link charges the
  // STORED figure (`quotePay.ts`: soldCents ?? totalCents). Approval snapshots the rate card but
  // never re-writes totalCents, so a quote saved before a rate-card deploy and approved after it
  // has a snapshot from the new card and a total from the old one. Preferring the recompute here
  // would print one number on the proposal and charge another at checkout — and the price-drift
  // indicator could not catch it, since that compares two stored figures.
  //
  // The secondary option has no stored counterpart, so it is necessarily a recompute; that is
  // fine, because ops re-prices the quote before any of it can be charged.
  const pricedTotal = quote.totalCents;
  const otherTotal = wantsBoth ? totalFor(other) : null;

  const waFor = (label: string | null) =>
    label
      ? `Hi! I'd like to book the ${label} option for quote ${quote.reference}`
      : `Hi! I have a question about quote ${quote.reference}`;

  const span = tripSpanDays(quote);
  const deltaTextFor = (service: 'private' | 'chauffeur', diff: number | null): string | null => {
    if (diff == null || diff <= 0) return null;
    if (service !== 'chauffeur') return `+${usd(diff)} — you travel journey by journey`;
    const perDay = span != null && span >= 2 ? Math.round(diff / 100 / span) : null;
    return perDay != null && perDay >= 1
      ? `+${usd(diff)} for the whole trip — about $${perDay} a day for your own driver-guide`
      : `+${usd(diff)} — your driver stays with you throughout`;
  };

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
      // "+$112 for the whole trip — about $12 a day" (owner, 2026-08-06): the same fact, priced
      // per day, is how an upsell reads as small. Only for the chauffeur upsell, only when the
      // trip's dates give an honest denominator, and never rounded below $1.
      deltaText: deltaTextFor(service, diff),
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
