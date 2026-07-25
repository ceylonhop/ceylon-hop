import { KNOWN_PLACES } from '../../adapters/maps';

// Defensive trip extraction from a stored quote's request_json (founder analytics spec
// 2026-07-23, §C). Runs over HISTORICAL json — anything malformed degrades to null, never
// throws. Modern rows are { tool, engine } (internalQuote.ts save path); legacy rows may be a
// bare engine request. Shared quotes return null: their legs are routeId-based (no place
// names), so they appear in mix tiles (from row columns) but not destination charts — the
// demand report's `coverage` field makes that exclusion visible.

export interface ExtractedTrip {
  places: string[];                                        // unique canonicalized stop names
  corridors: { from: string; to: string; km: number | null }[]; // first→last per ride, directional
  totalKm: number | null;                                  // null if any segment km is missing
  pax: number | null;
}

// Canonical name index: KNOWN_PLACES entry matched case-insensitively on the collapsed form.
const CANON = new Map<string, string>(KNOWN_PLACES.map((p) => [p.trim().toLowerCase(), p]));

function canonPlace(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (!collapsed) return null;
  return CANON.get(collapsed.toLowerCase()) ?? collapsed;
}

interface RawRide { stops: string[]; segmentKms: unknown[] }

// Accept both the old point-to-point shape and the ride shape, mirroring
// normalizeRide/normalizeChauffeurDay (quote/types.ts) but tolerant of bad data.
function toRide(leg: unknown): RawRide | null {
  if (!leg || typeof leg !== 'object') return null;
  const l = leg as Record<string, unknown>;
  if (Array.isArray(l.stops)) {
    if (l.stops.length < 2 || !l.stops.every((s) => typeof s === 'string')) return null;
    const segs = Array.isArray(l.segmentKms) ? l.segmentKms : l.stops.slice(1).map(() => null);
    return { stops: l.stops as string[], segmentKms: segs };
  }
  if (typeof l.from === 'string' && typeof l.to === 'string') {
    return { stops: [l.from, l.to], segmentKms: [l.distanceKm ?? null] };
  }
  return null;
}

export function extractTrip(request: unknown): ExtractedTrip | null {
  if (!request || typeof request !== 'object') return null;
  const wrapper = request as Record<string, unknown>;
  const engine = (wrapper.engine && typeof wrapper.engine === 'object' ? wrapper.engine : request) as Record<string, unknown>;

  let rawRides: unknown[];
  if (engine.product === 'private' && Array.isArray(engine.legs)) rawRides = engine.legs;
  else if (engine.product === 'chauffeur' && Array.isArray(engine.travelDays)) rawRides = engine.travelDays;
  else return null; // shared (routeId legs) or unrecognizable

  const places: string[] = [];
  const seen = new Set<string>();
  const corridors: ExtractedTrip['corridors'] = [];
  let totalKm: number | null = 0;

  for (const raw of rawRides) {
    const ride = toRide(raw);
    if (!ride) return null; // a malformed leg makes the whole trip untrustworthy
    const stops = ride.stops.map(canonPlace);
    if (stops.some((s) => s === null)) return null;
    for (const s of stops as string[]) {
      if (!seen.has(s)) { seen.add(s); places.push(s); }
    }
    let rideKm: number | null = 0;
    for (const seg of ride.segmentKms) {
      if (typeof seg === 'number' && Number.isFinite(seg) && seg >= 0 && rideKm !== null) rideKm += seg;
      else rideKm = null;
    }
    corridors.push({ from: stops[0] as string, to: stops[stops.length - 1] as string, km: rideKm });
    totalKm = totalKm !== null && rideKm !== null ? totalKm + rideKm : null;
  }
  if (corridors.length === 0) return null;

  const pax = typeof engine.pax === 'number' && Number.isFinite(engine.pax) ? engine.pax : null;
  return { places, corridors, totalKm, pax };
}
