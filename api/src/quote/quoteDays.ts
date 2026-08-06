// The customer-facing itinerary, as DAYS (spec 2026-08-05 §5.1). Pure over the stored quote —
// no repo, no clock — like payPageCopy beside it.
//
// The data only has legs, so a trip dated 20–28 with legs on 20/22/24/28 would render a section
// titled "Day by day" with days visibly missing, and a customer will count them. Every calendar
// day between the first and last leg therefore renders: days with no leg become quiet stays at
// the last place reached, and consecutive ones collapse into a range.
//
// A stay NEVER carries a price or a "rest day" framing: chauffeur idle-day pricing is
// deliberately understated in quotes and must stay that way.

export interface QuoteDayRow {
  kind: 'journey' | 'stay';
  date: string;
  title: string;
  meta: string | null;
  stops: string[];
}

interface ToolLegLite {
  from?: string;
  to?: string;
  date?: string;
  category?: string;
  distanceKm?: number;
  stops?: string[];
}

const DAY_MS = 86_400_000;

// UTC-midnight on the YYYY-MM-DD part — the same convention as payPageCopy's parseUtc and the
// engine's dayNumber, so a date here can never disagree with a date there.
function parseUtc(s: string | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(t) ? null : new Date(t);
}

// 'WED 20 AUG' — the mono row stamp, matching payPageCopy's legStamp exactly.
function stamp(d: Date): string {
  return d
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .toUpperCase()
    .replace(',', '');
}

function rangeStamp(a: Date, b: Date): string {
  return a.getTime() === b.getTime() ? stamp(a) : `${stamp(a)} – ${stamp(b)}`;
}

function endpoints(l: ToolLegLite): { from: string; to: string; mid: string[] } {
  const chain = Array.isArray(l.stops) && l.stops.length >= 2 ? l.stops : [l.from ?? '?', l.to ?? '?'];
  return { from: chain[0], to: chain[chain.length - 1], mid: chain.slice(1, -1) };
}

// "about 4 h" / "about 2 h 30" — a road-speed estimate, deliberately vague. 42 km/h is the
// engine's own working average for Sri Lankan roads; this is a reading aid, never a promise.
function durationText(km: number): string {
  const mins = Math.round((km / 42) * 60);
  const h = Math.floor(mins / 60);
  let hh = h;
  let m = Math.round((mins - h * 60) / 15) * 15;
  // Rounding the remainder to the nearest 15 minutes can land it exactly on 60 (e.g. 173
  // minutes -> h=2, remainder 53 -> rounds up to 60). Left uncarried that silently prints an
  // hour short ("about 2 h" instead of the honest "about 3 h"), so fold it into the hour.
  if (m === 60) {
    hh += 1;
    m = 0;
  }
  if (hh <= 0) return `about ${Math.max(15, m)} min`;
  return m > 0 && m < 60 ? `about ${hh} h ${m}` : `about ${hh} h`;
}

function journeyMeta(l: ToolLegLite): string | null {
  const km = typeof l.distanceKm === 'number' && l.distanceKm > 0 ? Math.round(l.distanceKm) : null;
  return km == null ? null : `${km} km · ${durationText(km)}`;
}

const isStay = (l: ToolLegLite) => (l.category || 'transfer') === 'stay_day';

export function quoteDays(quote: { request: unknown }): QuoteDayRow[] {
  const req = (quote.request ?? {}) as { tool?: { legs?: ToolLegLite[] } };
  const legs: ToolLegLite[] = Array.isArray(req.tool?.legs) ? req.tool!.legs! : [];
  if (!legs.length) return [];

  const rowFor = (l: ToolLegLite): QuoteDayRow => {
    const { from, to, mid } = endpoints(l);
    const d = parseUtc(l.date);
    if (isStay(l)) return { kind: 'stay', date: d ? stamp(d) : '', title: `In ${to || from}`, meta: null, stops: [] };
    return { kind: 'journey', date: d ? stamp(d) : '', title: `${from} → ${to}`, meta: journeyMeta(l), stops: mid };
  };

  // Any undated leg makes calendar arithmetic meaningless — fall back to journeys-only rather
  // than invent a sequence. Tours default to blank dates, so this path is real.
  if (legs.some((l) => !parseUtc(l.date))) return legs.map(rowFor);

  const sorted = [...legs].sort((a, b) => parseUtc(a.date)!.getTime() - parseUtc(b.date)!.getTime());
  const out: QuoteDayRow[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const leg = sorted[i];
    out.push(rowFor(leg));

    const next = sorted[i + 1];
    if (!next) break;
    const from = parseUtc(leg.date)!.getTime();
    const to = parseUtc(next.date)!.getTime();
    const gapDays = Math.round((to - from) / DAY_MS) - 1;
    if (gapDays < 1) continue;

    // Where they are while nothing is scheduled: wherever this leg left them.
    const place = endpoints(leg).to;
    out.push({
      kind: 'stay',
      date: rangeStamp(new Date(from + DAY_MS), new Date(from + gapDays * DAY_MS)),
      title: `In ${place}`,
      meta: null,
      stops: [],
    });
  }

  return out;
}
