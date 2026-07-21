// Maps adapter (M8): road distance + driving duration between two places.
// External service behind an adapter with a fake — the fake is used in tests and whenever
// no Google key is configured; the real Google adapter is config-selected on the server.

export interface DistanceResult {
  km: number;
  durationMin: number;
}

export interface RouteVariants {
  fastest: DistanceResult; // always present when the pair resolves at all
  noTolls: DistanceResult | null; // present ONLY when it is a materially different road
  hasChoice: boolean; // noTolls !== null
}

// Display rule: below this gap, the two routes are reported as "same route" (no choice offered).
export const CHOICE_MIN_TIME_SAVED_MIN = 45;

export interface MapsAdapter {
  readonly provider: string;
  // Returns null when the route can't be resolved (e.g. the fake doesn't know a typed address).
  distance(from: string, to: string): Promise<DistanceResult | null>;
  // Compares the default (fastest) route against an avoid=tolls route. Returns null when the
  // pair can't be resolved at all; otherwise `fastest` is always present (falling back to the
  // offline estimate for known places), and `noTolls`/`hasChoice` are set only when BOTH the
  // default and avoid=tolls calls succeeded against Google with a materially different result.
  distanceVariants(from: string, to: string): Promise<RouteVariants | null>;
  // Place suggestions for autocomplete. At most 6 display-name strings; [] when none/unavailable.
  places(query: string): Promise<string[]>;
}

// Shared fetch timeout for outbound Google Maps calls, so a slow/hanging upstream never
// stalls a request indefinitely.
const FETCH_TIMEOUT_MS = 4000;

// Sri Lanka is a ~430 km-tall island; its longest realistic point-to-point road trip
// (roughly Jaffna → Kataragama) is ~650 km. A larger "distance" means the origin or
// destination geocoded OUTSIDE the country — e.g. a half-typed name like "miris" matching
// a place on another continent (Distance Matrix returned 10,284 km in the field). We reject
// those as unresolved rather than let a fantasy distance flow into a price.
const MAX_SL_ROAD_KM = 900;

// Known-place coordinates, mirroring the front-end's place table (transfers-data.js). The
// fake estimates road distance as crow-flies × 1.35 (Sri Lankan roads are slow & winding) and
// duration at ~42 km/h — the same model the marketing site uses, so dev distances are realistic.
const COORDS: Record<string, [number, number]> = {
  'colombo airport (cmb)': [7.18, 79.88],
  'colombo city': [6.93, 79.85],
  negombo: [7.21, 79.84],
  bentota: [6.42, 79.99],
  hikkaduwa: [6.14, 80.1],
  galle: [6.03, 80.22],
  weligama: [5.97, 80.42],
  mirissa: [5.95, 80.46],
  kandy: [7.29, 80.63],
  'nuwara eliya': [6.95, 80.79],
  ella: [6.87, 81.05],
  'sigiriya / dambulla': [7.95, 80.76],
  anuradhapura: [8.31, 80.4],
  yala: [6.37, 81.52],
  'arugam bay': [6.84, 81.84],
  trincomalee: [8.59, 81.21],
};

// Display names for the known places (each normalizes to a COORDS key above). The internal quoting
// tool offers these for offline autocomplete, so distance resolves even without a Google key.
export const KNOWN_PLACES: string[] = [
  'Colombo Airport (CMB)', 'Colombo City', 'Negombo', 'Bentota', 'Hikkaduwa', 'Galle', 'Weligama',
  'Mirissa', 'Kandy', 'Nuwara Eliya', 'Ella', 'Sigiriya / Dambulla', 'Anuradhapura', 'Yala',
  'Arugam Bay', 'Trincomalee',
];

const norm = (s: string): string => s.trim().toLowerCase();

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// A place name → its exact SL coordinates, when it's one of our known places.
function knownCoords(name: string): [number, number] | null {
  return COORDS[norm(name)] ?? null;
}
// Offline road-distance estimate (crow-flies × 1.35, ~42 km/h) — only when BOTH endpoints
// are known places. Used by the fake adapter, and as the real adapter's fallback so a known
// pair never fails to price just because Google is down/ambiguous.
function offlineEstimate(from: string, to: string): DistanceResult | null {
  const a = knownCoords(from);
  const b = knownCoords(to);
  if (!a || !b) return null;
  const km = Math.round(haversineKm(a, b) * 1.35);
  return { km, durationMin: Math.round((km / 42) * 60) };
}

// Synthetic route-choice pairs for keyless dev + e2e, so the "Compare routes" picker has
// something real to show without a Google key. Owner's real corridor figures, 2026-07-20.
const FAKE_VARIANT_PAIRS: [string, string, DistanceResult, DistanceResult][] = [
  ['colombo city', 'ella', { km: 292, durationMin: 330 }, { km: 205, durationMin: 390 }],
  ['colombo airport (cmb)', 'galle', { km: 148, durationMin: 120 }, { km: 130, durationMin: 205 }],
];

function fakeVariantPair(from: string, to: string): RouteVariants | null {
  const a = norm(from);
  const b = norm(to);
  for (const [x, y, fastest, noTolls] of FAKE_VARIANT_PAIRS) {
    if ((a === x && b === y) || (a === y && b === x)) {
      return { fastest, noTolls, hasChoice: true };
    }
  }
  return null;
}

export class FakeMapsAdapter implements MapsAdapter {
  readonly provider = 'fake';
  async distance(from: string, to: string): Promise<DistanceResult | null> {
    return offlineEstimate(from, to);
  }

  async distanceVariants(from: string, to: string): Promise<RouteVariants | null> {
    const choice = fakeVariantPair(from, to);
    if (choice) return choice;
    const fastest = offlineEstimate(from, to);
    if (!fastest) return null;
    return { fastest, noTolls: null, hasChoice: false };
  }

  // Mirrors the offline fallback the route used to do itself: case-insensitive substring
  // match over the known-place list, capped at 6 suggestions.
  async places(query: string): Promise<string[]> {
    const ql = query.toLowerCase();
    return KNOWN_PLACES.filter((p) => p.toLowerCase().includes(ql)).slice(0, 6);
  }
}

// Real adapter: Google Distance Matrix (driving). Resolves names/addresses server-side.
export class GoogleMapsAdapter implements MapsAdapter {
  readonly provider = 'google';
  constructor(private readonly apiKey: string) {}

  // On-demand default-vs-avoid=tolls comparisons. Keyed by normalized "from|to". Cached only
  // on full success (see distanceVariants) — a transient Google failure must be retryable
  // immediately, never hidden behind a 24h cache entry.
  private variantsCache = new Map<string, { expires: number; value: RouteVariants }>();

  async distance(from: string, to: string): Promise<DistanceResult | null> {
    return (await this.googleDistance(from, to)) ?? offlineEstimate(from, to);
  }

  async distanceVariants(from: string, to: string): Promise<RouteVariants | null> {
    const key = `${norm(from)}|${norm(to)}`;
    const hit = this.variantsCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const [fast, slow] = await Promise.all([
      this.googleDistance(from, to),
      this.googleDistance(from, to, true),
    ]);
    const fastest = fast ?? offlineEstimate(from, to);
    if (!fastest) return null;
    // A choice requires BOTH answers from Google (never the offline estimate) + a material gap.
    const hasChoice = !!fast && !!slow && slow.durationMin - fast.durationMin >= CHOICE_MIN_TIME_SAVED_MIN;
    const value: RouteVariants = { fastest, noTolls: hasChoice ? slow : null, hasChoice };
    // Cache ONLY full successes: a failed/partial comparison must be retryable immediately.
    if (fast && slow) {
      if (this.variantsCache.size >= 500) this.variantsCache.clear();
      this.variantsCache.set(key, { expires: Date.now() + 24 * 60 * 60 * 1000, value });
    }
    return value;
  }

  private async googleDistance(from: string, to: string, avoidTolls = false): Promise<DistanceResult | null> {
    // A known place goes to Google as its exact "lat,lng", never the bare name: a name like
    // "Ella" (which exists in many countries) otherwise geocodes outside Sri Lanka and gets
    // rejected as implausible, so picking a "Popular route" suggestion resolved no distance.
    const o = knownCoords(from);
    const d = knownCoords(to);
    const origin = o ? `${o[0]},${o[1]}` : from;
    const dest = d ? `${d[0]},${d[1]}` : to;
    const url =
      'https://maps.googleapis.com/maps/api/distancematrix/json' +
      `?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(dest)}` +
      `&mode=driving&region=lk&key=${this.apiKey}` +
      (avoidTolls ? '&avoid=tolls' : '');
    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch {
      console.error('[maps] Distance Matrix error: fetch failed or timed out');
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.error(`[maps] Distance Matrix error: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      status?: string;
      rows?: { elements?: { status?: string; distance?: { value: number }; duration?: { value: number } }[] }[];
    };
    if (data.status && data.status !== 'OK') {
      console.error('[maps] Distance Matrix error: ' + data.status);
      return null;
    }
    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK' || !el.distance || !el.duration) return null;
    const km = Math.round(el.distance.value / 1000);
    if (km > MAX_SL_ROAD_KM) {
      console.error(`[maps] implausible distance ${km} km for "${from}" → "${to}" — treating as unresolved (likely a bad geocode outside Sri Lanka)`);
      return null;
    }
    return { km, durationMin: Math.round(el.duration.value / 60) };
  }

  // Places Autocomplete, mirroring the request the route used to make directly. Google is
  // tried first; on any non-usable outcome (error, timeout, non-OK status, or zero
  // predictions) we fall back to the offline KNOWN_PLACES filter, exactly preserving the
  // route's old "Google first, offline fallback" behavior.
  async places(query: string): Promise<string[]> {
    const url =
      'https://maps.googleapis.com/maps/api/place/autocomplete/json' +
      `?input=${encodeURIComponent(query)}&components=country:lk&key=${this.apiKey}`;
    const offlineFallback = (): string[] => {
      const ql = query.toLowerCase();
      return KNOWN_PLACES.filter((p) => p.toLowerCase().includes(ql)).slice(0, 6);
    };

    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch {
      console.error('[maps] places error: fetch failed or timed out');
      return offlineFallback();
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.error(`[maps] places error: HTTP ${res.status}`);
      return offlineFallback();
    }
    const data = (await res.json()) as { status?: string; predictions?: { description: string }[] };
    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('[maps] places error: ' + data.status);
      return offlineFallback();
    }
    const out = (data.predictions || []).slice(0, 6).map((p) => p.description);
    if (out.length) return out;
    return offlineFallback();
  }
}
