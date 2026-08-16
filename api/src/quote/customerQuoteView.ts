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
  /* What the money buys, as SEPARATE lines (owner, 2026-08-16): a customer scanning two totals
     has to be able to see what each one covers, and a `·`-joined sentence made three inclusions
     read as one paragraph. `lead` is the chauffeur card's "Everything in Private transfers,
     plus:" — a sentence ABOUT the list, not an item in it. */
  included: { lead: string | null; items: string[] };
  /* The same content as one sentence. Legacy: the ONLY reader is a quote.html cached before the
     bullets shipped (api-served customer pages cache hard), which would otherwise print an empty
     Included box. Derived from `included`, never authored — delete once caches have turned over. */
  includedText: string;
  totalCents: number;
  totalUsd: string;
  /* A founder discount, when one is applied. Both figures come from the STORED result, and
     because finishing runs BEFORE the discount (owner, 2026-08-09) they reconcile exactly:
     totalBeforeUsd − discountUsd === totalUsd. That is why the customer can be shown a
     breakdown at all — the old order left a cent stranded in the hidden finishing row. */
  discount?: { totalBeforeUsd: string; discountUsd: string };
  cancellation: { headline: string; ladder: string[] };
  lead: boolean;
  waText: string;
  legPrices: QuoteViewLegPrices | null;
}

/* What each journey costs, for the customer who asked (spec 2026-08-16). Display-only, and
   whole dollars: `reconcile` is the REMAINDER against the charged total, never the engine's own
   `price_adjustment` row — so rows + reconcile + discount === totalCents by construction,
   whatever rounding and finishing did. That is the arithmetic the customer will check. */
export interface QuoteViewLegPrices {
  rows: { label: string; amountUsd: string }[];
  reconcile: { label: string; amountUsd: string } | null;
  discount: { label: string; amountUsd: string } | null;
  totalUsd: string;
}

// A stretch of the journey the map draws with ONE route query. Ops can pin a leg to the
// toll-free road (routeVariant: 'no_tolls'), but avoidTolls is a per-REQUEST modifier, so a
// journey whose legs disagree has to be split. `continues` marks a run that starts where the
// previous one ended — a road-choice split, not a gap — so the shared stop isn't pinned twice.
export interface MapRun {
  stops: string[];
  avoidTolls: boolean;
  continues: boolean;
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
  mapRuns: MapRun[];
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
  /** The stored QuoteResult. Carries the founder's discount when there is one. */
  result?: unknown;
  showLegPrices?: boolean;
}

interface ToolLegLite {
  from?: string; to?: string; date?: string; category?: string; distanceKm?: number; stops?: string[];
  routeVariant?: string;
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
    blurb: "The lowest-cost way to do this trip — you only pay for the days you're moving.",
    included: {
      lead: null,
      items: ['Pick up and drop off', 'Air-conditioned car with driver', 'Fuel, tolls and parking'],
    },
  },
  chauffeur: {
    // 'Chauffeur-guide' — the site's own term (booking.js's label, terms.html §7's defined
    // term, every tour page). This card was the ONLY surface calling it anything else.
    name: 'Chauffeur-guide',
    blurb: 'Total flexibility — your own driver-guide from start to finish, stopping wherever you like.',
    // "Everything in X, plus" — pricing-table grammar. The two cards' included boxes used to be
    // near-identical feature lists, so scanning them answered nothing about what the extra money
    // buys; this one now lists only the difference.
    included: {
      lead: 'Everything in Private transfers, plus:',
      items: [
        'Your car and driver stays for the whole trip',
        'Sightseeing, waiting',
        "Driver's meals & rooms covered",
      ],
    },
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

// The pre-bullets sentence, rebuilt from the bullets so the two can never say different things.
// Only a stale cached quote.html reads it; see QuoteViewOption.includedText.
const legacyIncludedText = (inc: { lead: string | null; items: readonly string[] }): string =>
  `${inc.lead ? `${inc.lead} ` : ''}${inc.items.join(' · ')}.`;

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

// The same stops, grouped into the runs CH_MAP.renderRoute() queries: a new run wherever the
// journey breaks (one leg doesn't start where the last ended) or the road choice changes.
// Legs that agree — nearly every quote — still make exactly one request, so the common case
// bills no extra Maps calls. Mirrors itinRuns() in api/src/routes/ops-ui.html, which draws the
// same journey for ops; the two are separate because the ops shell is a self-contained
// single-file app with no way to import this. Change one, change both.
function mapRunsOf(quote: ViewQuote): MapRun[] {
  const runs: { stops: string[]; avoidTolls: boolean }[] = [];
  let cur: { stops: string[]; avoidTolls: boolean } | null = null;
  for (const l of legsOf(quote).filter(drives)) {
    const chain = (Array.isArray(l.stops) && l.stops.length >= 2 ? l.stops : [l.from ?? '', l.to ?? ''])
      .map((s) => (s ?? '').trim())
      .filter(Boolean);
    if (!chain.length) continue;
    const avoidTolls = l.routeVariant === 'no_tolls';
    const joins = !!cur && cur.stops[cur.stops.length - 1] === chain[0];
    if (!cur || !joins || cur.avoidTolls !== avoidTolls) {
      cur = { stops: [], avoidTolls };
      runs.push(cur);
    }
    for (const s of chain) if (s !== cur.stops[cur.stops.length - 1]) cur.stops.push(s);
  }
  // Resolve `continues` against the KEPT list: a one-stop leg can open a run dropped here, and
  // the run after it must not be told it joins something that isn't drawn. Two kept runs can
  // only meet at a stop when a road choice split them — the grouping above merges them otherwise.
  const kept = runs.filter((r) => r.stops.length >= 2);
  return kept.map((r, i) => ({
    stops: r.stops,
    avoidTolls: r.avoidTolls,
    continues: i > 0 && kept[i - 1].stops[kept[i - 1].stops.length - 1] === r.stops[0],
  }));
}

interface StoredLineItem {
  label: string;
  amountCents: number;
  meta?: { kind?: string; legIndex?: number };
}

// "Colombo Airport → Sigiriya (car)" → "Colombo Airport → Sigiriya". The vehicle tag is an ops
// annotation; the customer already knows what they are travelling in.
const journeyLabel = (label: string): string => label.replace(/\s*\([^()]*\)\s*$/, '');

const wholeDollars = (cents: number): number => Math.round(cents / 100) * 100;

// A stored row is JSON off the wire and can be malformed (an old shape, a hand-edited result).
// A missing or non-numeric amount degrades to $0 rather than poisoning its row AND the
// remainder with "$NaN" — the customer sees a wrong-looking zero, never a broken page.
const amountOf = (li: StoredLineItem): number =>
  typeof li.amountCents === 'number' && Number.isFinite(li.amountCents) ? li.amountCents : 0;

function legPricesFor(
  quote: ViewQuote,
  product: string | null,
  lead: boolean,
  drivingLegCount: number,
  totalCents: number,
  discountOff: number | null,
): QuoteViewLegPrices | null {
  // Lead-only and private-only. The secondary option's total is a recompute with no stored
  // lineItems behind it, so a breakdown there would reconcile to a number that was never
  // approved — the same reason the stored total already outranks the recompute. Chauffeur is
  // priced by the day and has no per-leg price to show at all.
  //
  // Gate on the ENGINE's product, not the view's service: the view maps every non-chauffeur
  // product onto the 'private' card, so a `shared` quote would slip a private-only gate.
  if (!quote.showLegPrices || !lead || product !== 'private') return null;

  const stored = (quote.result ?? {}) as { lineItems?: StoredLineItem[] };
  const items = Array.isArray(stored.lineItems) ? stored.lineItems : [];
  // "The first N are the driving legs" — the contract engine.ts states where it pushes extras
  // AFTER the travel rows on purpose, and the same split ops-ui makes. N is the REQUEST's own
  // driving-leg count, never a meta sniff: an unattributed extra is pushed as a bare
  // { label, amountCents } with no `meta` at all (extrasDeposit.ts), so by shape alone it is
  // indistinguishable from a travel row — counting it as one would shift every later price
  // onto the wrong journey. A stored list shorter than N (a legacy or partial result) just
  // yields the rows it has.
  const n = Math.min(drivingLegCount, items.length);
  const legs = items.slice(0, n);
  if (!legs.length) return null;

  // Everything after the legs is an extra, the engine's finishing adjustment, or the discount.
  // The last two are skipped: `reconcile` below is the remainder against the CHARGED total, so
  // reading the engine's own adjustment back would double-count it. An extra attributed to a
  // leg folds into that leg, so the rail stays one row per journey.
  const amounts = legs.map(amountOf);
  const loose: StoredLineItem[] = [];
  for (const e of items.slice(n)) {
    const kind = e.meta?.kind;
    if (kind === 'price_adjustment' || kind === 'discount') continue;
    const i = e.meta?.legIndex;
    if (i != null && Number.isInteger(i) && i >= 0 && i < amounts.length) amounts[i] += amountOf(e);
    else loose.push(e);
  }

  // journeyLabel strips a trailing "(car)"-style vehicle tag, and is safe by construction now
  // that it only ever sees real driving legs — those always carry the tag. A loose extra's own
  // parenthetical ("Sightseeing stops (up to 3h)") is part of what it IS, so its label is left
  // exactly as stored: stripping it there would delete meaning, not an ops annotation.
  const rows = [
    ...legs.map((li, i) => ({ label: journeyLabel(li.label), cents: wholeDollars(amounts[i]) })),
    ...loose.map((e) => ({ label: e.label, cents: wholeDollars(amountOf(e)) })),
  ];

  // rows + reconcile − discount === totalCents, solved for reconcile.
  const off = discountOff ?? 0;
  const gap = totalCents + off - rows.reduce((s, r) => s + r.cents, 0);

  return {
    rows: rows.map((r) => ({ label: r.label, amountUsd: usd(r.cents) })),
    reconcile: gap === 0
      ? null
      : { label: gap < 0 ? 'Rounded down' : 'Rounding', amountUsd: `${gap < 0 ? '−' : '+'}${usd(Math.abs(gap))}` },
    discount: off > 0 ? { label: 'Discount', amountUsd: `−${usd(off)}` } : null,
    totalUsd: usd(totalCents),
  };
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
  // The founder's negotiation, straight off the stored result — no recompute, no extra query.
  const storedResult = (quote.result ?? {}) as { totalBeforeDiscountCents?: number; discountCents?: number };
  const discountOff = storedResult.discountCents && storedResult.discountCents > 0 ? storedResult.discountCents : null;
  /* The pre-discount total. DERIVED when the stored result predates the finishing reorder (#422),
     which renamed discountedSubtotalCents → totalBeforeDiscountCents: a quote discounted before
     that deploy carries the old field, and requiring the new one made the breakdown silently
     vanish on a genuinely discounted quote (Q-ZKPZY, $259 → $229, observed on staging).
     total + discount is exact under the current order — total IS totalBefore − discount — so the
     derivation is not a fallback approximation, it is the same arithmetic read the other way. */
  const discountBefore = discountOff == null
    ? null
    : storedResult.totalBeforeDiscountCents ?? pricedTotal + discountOff;
  const otherTotal = wantsBoth ? totalFor(other) : null;

  // The driving legs of the REQUEST. Read before the cards are built: it is both the trip stat
  // and the N that splits the stored lineItems into "the first N are the driving legs".
  const driving = legsOf(quote).filter(drives);

  const waFor = (label: string | null) =>
    label
      ? `Hi! I'd like to book the ${label} option for quote ${quote.reference}`
      : `Hi! I have a question about quote ${quote.reference}`;

  // Both cards use THIS file's copy, not payPageCopy's inclusion sentence (owner, 2026-08-06).
  // The pay-page-parity reuse put "your time is your own" in the lead card twice and left the
  // two included boxes scanning as near-identical lists — on the comparison card the job is a
  // value proposition, and the two must read as parallel statements of what each buys.
  const build = (service: 'private' | 'chauffeur', cents: number, lead: boolean): QuoteViewOption => {
    const c = COPY[service];
    return {
      service,
      name: c.name,
      blurb: c.blurb,
      included: { lead: c.included.lead, items: [...c.included.items] },
      includedText: legacyIncludedText(c.included),
      totalCents: cents,
      totalUsd: usd(cents),
      // Only on the card that was actually priced: the comparison card is a recompute with no
      // stored discount behind it, so showing one there would be inventing a saving.
      ...(lead && discountBefore != null && discountOff != null
        ? { discount: { totalBeforeUsd: usd(discountBefore), discountUsd: usd(discountOff) } }
        : {}),
      cancellation: { headline: CANCELLATION[service].headline, ladder: [...CANCELLATION[service].ladder] },
      lead,
      waText: waFor(c.name),
      legPrices: legPricesFor(
        quote,
        engine?.product ?? null,
        lead,
        driving.length,
        cents,
        lead ? discountOff : null,
      ),
    };
  };

  const options: QuoteViewOption[] = [build(priced, pricedTotal, true)];
  if (otherTotal != null) options.push(build(other, otherTotal, false));

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
    mapRuns: mapRunsOf(quote),
    totalKm,
    travelDays: driving.length,
    options,
    waText: waFor(null),
  };
}
