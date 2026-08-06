// Which FIELDS differ between two versions of a quote (spec 2026-08-05 §6). Names, never values:
// "extras changed, total changed" is what turns a mystery price move into a sentence, and naming
// only fields keeps margin-bearing content off the wire by construction.
//
// Defensive throughout. It runs over stored rows that may predate any given field, and a history
// panel that 500s on one odd legacy revision is worse than one that says "legs" and moves on.

export interface QuoteVersion {
  request: unknown;
  totalCents: number;
}

interface LegLike {
  stops?: string[];
  segmentKms?: number[];
  from?: string;
  to?: string;
  distanceKm?: number;
}

const engineOf = (v: QuoteVersion): Record<string, unknown> =>
  (v.request as { engine?: Record<string, unknown> } | null | undefined)?.engine ?? {};

const toolLegsOf = (v: QuoteVersion): { date?: string }[] =>
  (v.request as { tool?: { legs?: { date?: string }[] } } | null | undefined)?.tool?.legs ?? [];

// Chauffeur quotes carry `travelDays`, private carry `legs` — both are "the legs" here.
const legsOf = (v: QuoteVersion): LegLike[] => {
  const e = engineOf(v);
  const list = (e.legs ?? e.travelDays) as unknown;
  return Array.isArray(list) ? (list as LegLike[]) : [];
};

// Old-shape legs are {from,to,distanceKm}; Rides are {stops,segmentKms}. Normalise so the two
// forms of the same journey don't read as a change.
const stopsOf = (legs: LegLike[]): unknown[] =>
  legs.map((l) => l.stops ?? [l.from, l.to]);
const kmsOf = (legs: LegLike[]): unknown[] =>
  legs.map((l) => l.segmentKms ?? [l.distanceKm]);

const j = (x: unknown): string => JSON.stringify(x ?? null);

export function changedFields(prev: QuoteVersion, next: QuoteVersion): string[] {
  const out: string[] = [];
  const a = engineOf(prev);
  const b = engineOf(next);
  const legsA = legsOf(prev);
  const legsB = legsOf(next);

  if (legsA.length !== legsB.length) {
    out.push('legs');
  } else {
    // Same leg count — say WHAT about them moved, which is the useful half. A pickup edit that
    // leaves the price alone must read as `stops`, not as a vague "legs".
    if (j(stopsOf(legsA)) !== j(stopsOf(legsB))) out.push('stops');
    if (j(kmsOf(legsA)) !== j(kmsOf(legsB))) out.push('distance');
  }

  if (j(a.extras) !== j(b.extras)) out.push('extras');
  if (a.vehicle !== b.vehicle) out.push('vehicle');
  if (a.pax !== b.pax) out.push('pax');
  if (a.bags !== b.bags) out.push('bags');

  // Dates live in the TOOL half — a PrivateLeg has no date of its own.
  const datesA = toolLegsOf(prev).map((l) => l?.date ?? null);
  const datesB = toolLegsOf(next).map((l) => l?.date ?? null);
  if (j(datesA) !== j(datesB)) out.push('dates');

  if (prev.totalCents !== next.totalCents) out.push('total');

  return out;
}
