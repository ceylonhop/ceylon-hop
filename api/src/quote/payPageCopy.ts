// Customer copy for the pay page (spec D11, 2026-07-31). DETERMINISTIC on purpose: every
// word derives from fields the operator already entered in the builder, so nothing this
// page says to a customer can be invented — if a title reads wrong, the quote is wrong,
// which is the trip calendar's job to catch before sending. No repo access, no clock: a
// pure function over the stored quote, like tripCal in the ops shell.

export type PayPageProduct = 'single' | 'multi' | 'chauffeur';

export interface PayPageCopy {
  product: PayPageProduct;
  greetingName: string | null; // first word of customerName; null → the page omits the greeting
  title: string;
  subtitle: string;
  facts: { k: string; v: string; sub?: string }[]; // ticket rows (single + chauffeur shapes)
  // multi only — one thin row per journey. `covered` is set ONLY on a partial link: true = this
  // payment buys it, false = it is in the itinerary but not in this payment.
  legs: { route: string; date: string | null; covered?: boolean }[] | null;
  includedText: string;
  totalLabel: string;
}

interface ToolLegLite {
  from?: string;
  to?: string;
  date?: string;
  category?: string;
  stops?: string[];
}

import { shortPlace } from './shortPlace';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// UTC-midnight on the YYYY-MM-DD part — the same convention as the engine's dayNumber()
// and the ops shell's tripCal, so a span here can never disagree with a span there.
function parseUtc(s: string | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(t) ? null : new Date(t);
}

const countWord = (n: number): string => (n >= 2 && n <= 12 ? WORDS[n][0].toUpperCase() + WORDS[n].slice(1) : String(n));

// 'THU 20 AUG' — the mono row stamp the mockups use for multi-leg journeys.
function legStamp(d: Date): string {
  return d
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .toUpperCase()
    .replace(',', '');
}

// 'Wed 12 Aug' — the Starts fact.
function shortDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// 'Saturday 8 August 2026' — the single-transfer subtitle.
function longDate(d: Date): string {
  return `${d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// '20–24 August' (or '20 August – 3 September' across months) for the multi title.
function rangeLabel(first: Date, last: Date): string {
  const m1 = MONTHS[first.getUTCMonth()];
  const m2 = MONTHS[last.getUTCMonth()];
  if (m1 === m2 && first.getUTCFullYear() === last.getUTCFullYear()) {
    return `${first.getUTCDate()}–${last.getUTCDate()} ${m1}`;
  }
  return `${first.getUTCDate()} ${m1} – ${last.getUTCDate()} ${m2}`;
}

function vehicleLabel(tier: string | null | undefined): string {
  if (!tier) return 'Vehicle';
  if (tier === 'car') return 'Car';
  if (tier.startsWith('van')) return 'Van';
  return 'Vehicle';
}

// Does this place read as an airport? Same test the ops shell raises its airport flag on, so the
// pay page and the ops sheet can never disagree about what an airport run is.
const AIRPORT_RE = /airport|cmb|katunayake/i;
const isAirportPlace = (s: string | undefined): boolean => !!s && AIRPORT_RE.test(s);

// The endpoints, in travel order — the same resolution legRoute() renders from.
function legEnds(l: ToolLegLite): [string, string] {
  const stops = Array.isArray(l.stops) && l.stops.length >= 2 ? l.stops : [l.from ?? '', l.to ?? ''];
  return [stops[0] ?? '', stops[stops.length - 1] ?? ''];
}

// What a single transfer actually includes. Until 2026-08-07 this sentence was a constant that
// promised "Airport pickup with a name board" on EVERY one-leg private transfer — so a
// Sigiriya → Kandy page told the customer we'd meet them at an airport that appears nowhere in
// their trip (owner-caught on a live pay page). That is exactly the invention this file's header
// says cannot happen, so the copy now follows the endpoints.
//
// Direction matters and is why the name board can't simply be conditioned on "is an airport
// involved": the board is an ARRIVALS service. On a Kandy → CMB run the airport is the drop-off,
// and promising a name board there would be a second wrong sentence, not a fix.
//
// The last case is deliberately silent rather than guessing: an operator-set airport category
// with no airport in either endpoint name tells us a terminal is involved but not which end, and
// a wrong pickup promise is worse than no pickup line at all.
function transferIncludedText(l: ToolLegLite): string {
  const base = 'Driver, fuel and highway tolls.';
  const [from, to] = legEnds(l);
  if (isAirportPlace(from)) return `${base} Airport pickup with a name board.`;
  if (isAirportPlace(to)) return `${base} Hotel pickup and airport drop-off.`;
  if (l.category === 'airport') return base;
  return `${base} Hotel pickup and drop-off.`;
}

function legRoute(l: ToolLegLite): string {
  const stops = Array.isArray(l.stops) && l.stops.length >= 2 ? l.stops : [l.from ?? '?', l.to ?? '?'];
  // Short labels (2026-08-06): a full Google address wraps this row to three lines on a phone.
  return `${shortPlace(stops[0])} → ${shortPlace(stops[stops.length - 1])}`;
}

// `selection` (spec 2026-08-04 partial links) — the legs THIS payment covers, by index into the
// engine's driving legs. Omit it, or pass one covering everything, and every word below is
// byte-identical to the whole-trip page.
//
// It exists because a partial payment page cannot be built by bolting a receipt onto whole-trip
// copy: the owner caught a live page whose total read "all 4 journeys" over a two-leg payment
// (2026-08-05). One quiet "covers 2 of 4" line cannot outvote a headline saying otherwise, so the
// copy itself has to know.
export function payPageCopy(quote: {
  customerName: string | null;
  vehicle: string | null;
  request: unknown;
  totalCents: number;
}, selection?: { legIndexes: number[]; extraIndexes?: number[] } | null): PayPageCopy {
  const req = (quote.request ?? {}) as { tool?: { legs?: ToolLegLite[]; passengerCount?: number }; engine?: { product?: string; firstDate?: string; lastDate?: string } | null };
  const toolLegs: ToolLegLite[] = Array.isArray(req.tool?.legs) ? req.tool!.legs! : [];
  const driving = toolLegs.filter((l) => (l.category || 'transfer') !== 'stay_day');
  const engine = req.engine ?? null;

  const greetingName = (quote.customerName ?? '').trim().split(/\s+/)[0] || null;
  const veh = vehicleLabel(quote.vehicle);
  const pax = typeof req.tool?.passengerCount === 'number' ? req.tool.passengerCount : null;
  const paxLabel = pax != null ? `${pax}` : null;

  const firstStop = driving[0] ? legRoute(driving[0]).split(' → ')[0] : null;
  const lastStop = driving.length ? legRoute(driving[driving.length - 1]).split(' → ').pop()! : null;
  const fallbackTitle = firstStop && lastStop ? `${firstStop} → ${lastStop}` : 'Your trip';

  // ── chauffeur: the SHAPE, not the itinerary (spec D9) ─────────────────────────────────
  if (engine?.product === 'chauffeur') {
    const first = parseUtc(engine.firstDate);
    const last = parseUtc(engine.lastDate);
    const span = first && last ? Math.max(1, Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1) : null;
    const title = span ? `${countWord(span)} days across Sri Lanka` : fallbackTitle;
    const subtitleBits = [
      first && last ? rangeLabel(first, last) : null,
      `your own ${veh.toLowerCase()} & driver`,
    ].filter(Boolean);
    return {
      product: 'chauffeur',
      greetingName,
      title,
      subtitle: subtitleBits.join(' · '),
      facts: [
        { k: 'Trip', v: fallbackTitle, sub: 'full day-by-day plan in your quote' },
        { k: 'Days', v: span != null ? `${span} with your driver` : 'with your driver', sub: 'including your free days' },
        { k: 'Travellers', v: paxLabel ? `${paxLabel} · ${veh}` : veh },
        { k: 'Starts', v: first ? shortDate(first) : '—' },
      ],
      legs: null,
      includedText: `Vehicle & English-speaking driver${span != null ? ` for all ${span} days` : ''} · fuel and tolls · driver's meals and accommodation.`,
      totalLabel: span != null ? `Total · ${span} days` : 'Total',
    };
  }

  // ── single transfer: the journey IS the page (spec D9). One driving leg — even a
  // multi-stop ride — is one journey; the route renders first → last. ──────────────────
  if (engine?.product === 'private' && driving.length === 1) {
    const l = driving[0];
    const d = parseUtc(l.date);
    return {
      product: 'single',
      greetingName,
      title: legRoute(l),
      subtitle: d ? longDate(d) : 'date to be confirmed',
      facts: [
        ...(paxLabel ? [{ k: 'Travellers', v: paxLabel }] : []),
        { k: 'Vehicle', v: `Private ${veh.toLowerCase()}` },
      ],
      legs: null,
      includedText: transferIncludedText(l),
      totalLabel: 'Total',
    };
  }

  // ── multi-leg: EVERY journey, one thin row each, no per-leg prices or km (spec D9).
  // Gated on a real private engine: an engine-less legacy row must take the fallback
  // below, not render as “One journeys”. ───────────────────────────────────────────────
  if (engine?.product === 'private' && driving.length >= 2) {
    const dates = driving.map((l) => parseUtc(l.date)).filter((d): d is Date => !!d);
    const first = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
    const last = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    const count = driving.length;
    // A selection covering every journey is not a partial payment — say nothing different.
    const sold = selection ? [...new Set(selection.legIndexes)].filter((i) => i >= 0 && i < count) : null;
    const partial = sold && sold.length > 0 && sold.length < count;

    const title = partial
      ? `${countWord(sold!.length)} of your ${countWord(count).toLowerCase()} journeys`
      : first && last && dates.length === count
        ? `${countWord(count)} journeys, ${rangeLabel(first, last)}`
        : `${countWord(count)} journeys`;
    return {
      product: 'multi',
      greetingName,
      title,
      subtitle: [`Private ${veh.toLowerCase()}`, paxLabel ? `${paxLabel} travellers` : null].filter(Boolean).join(' · '),
      facts: [],
      // Every journey is still listed on a partial link — the customer keeps sight of the whole
      // trip — but each one says whether this payment buys it.
      legs: driving.map((l, i) => {
        const d = parseUtc(l.date);
        const row: { route: string; date: string | null; covered?: boolean } = {
          route: legRoute(l), date: d ? legStamp(d) : null,
        };
        if (partial) row.covered = sold!.includes(i);
        return row;
      }),
      includedText: partial
        ? 'Driver, fuel and tolls on the journeys this payment covers. Between trips, your time is your own.'
        : 'Driver, fuel and tolls on every journey. Between trips, your time is your own.',
      // NEVER "all N journeys" on a partial payment — that is the sentence that misled a paying
      // customer in prod.
      totalLabel: partial ? `Total · ${sold!.length} of your ${count} journeys` : `Total · all ${count} journeys`,
    };
  }

  // ── unresolvable (legacy row, engine missing): endpoints and a plain total ───────────
  return {
    product: 'single',
    greetingName,
    title: fallbackTitle,
    subtitle: '',
    facts: paxLabel ? [{ k: 'Travellers', v: paxLabel }] : [],
    legs: null,
    includedText: 'Driver, fuel and tolls included.',
    totalLabel: 'Total',
  };
}
