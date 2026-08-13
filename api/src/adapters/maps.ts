// Maps adapter (M8): road distance + driving duration between two places.
// External service behind an adapter with a fake — the fake is used in tests and whenever
// no Google key is configured; the real Google adapter is config-selected on the server.

export interface DistanceResult {
  km: number;
  durationMin: number;
  // True when this came from the crow-flies fallback instead of a real road lookup, i.e. Google
  // failed. It is not a road distance and is wrong in both directions (Colombo→Ella measured 39%
  // low, CMB→Galle 22% high), so it must never silently become a price a customer pays. Set by
  // the REAL adapter only — the fake's estimate is its normal output in dev/test.
  estimated?: boolean;
}

export interface RouteVariants {
  fastest: DistanceResult; // always present when the pair resolves at all
  noTolls: DistanceResult | null; // present ONLY when it is a materially different road
  hasChoice: boolean; // noTolls !== null
}

// Display rule: below these gaps, the two routes are reported as "same route" (no choice
// offered). Both must hold: quotes price per km, so a fork with near-identical distances
// produces near-identical prices — a "choice" that only trades time for nothing.
export const CHOICE_MIN_TIME_SAVED_MIN = 45;
export const CHOICE_MIN_KM_DIFF_PCT = 0.15;

export function isMaterialRouteChoice(fastest: DistanceResult, noTolls: DistanceResult): boolean {
  if (noTolls.durationMin - fastest.durationMin < CHOICE_MIN_TIME_SAVED_MIN) return false;
  if (fastest.km <= 0) return false;
  return Math.abs(fastest.km - noTolls.km) / fastest.km >= CHOICE_MIN_KM_DIFF_PCT;
}

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
  // Where a string might be. Used ONLY by the place resolver, to test a candidate against places
  // already trusted — never to adopt a coordinate directly. null when nothing/unavailable.
  //
  // OPTIONAL: an adapter without it simply cannot auto-link, so every unknown string falls
  // through to human confirmation. That is the fail-closed direction, and it keeps the many
  // existing test stubs of this interface valid.
  geocode?(query: string): Promise<GeocodedPoint | null>;
  // Distinguishable candidates for the ops "Confirm location" panel: same shape as geocode(),
  // but several, so a human can choose between two places that share a name.
  placeCandidates?(query: string): Promise<GeocodedPoint[]>;
}

// A point the geocoder believes a string refers to. `area` is the administrative area (e.g.
// "Southern Province") — the thing that actually distinguishes two places sharing a name, since
// Google's own autocomplete renders both "Yala" and "Yala National Park" as plain "Sri Lanka".
export interface GeocodedPoint {
  lat: number;
  lng: number;
  displayName: string;
  area: string | null;
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
  // Multi-stop via-stops (Phase 2 §5 catalog pre-check): en-route POIs / hubs customers ask
  // for on multi-stop days but that weren't in the point-to-point catalog. Coords feed the
  // offline crow-flies estimate + autocomplete; existing pairs are unaffected.
  polonnaruwa: [7.94, 81.0],
  habarana: [8.04, 80.75],
  'nilaveli beach': [8.7, 81.19],
  'nanu oya': [6.94, 80.77],
  thanthirimale: [8.42, 80.22],
  dambulla: [7.86, 80.65],
  udawalawe: [6.44, 80.89],
  tissamaharama: [6.28, 81.29],
  tangalle: [6.02, 80.79],
  unawatuna: [6.01, 80.25],
  pasikudah: [7.92, 81.56],
  hatton: [6.89, 80.6],
  'adam\'s peak': [6.81, 80.5],
  wilpattu: [8.45, 80.05],
  kalpitiya: [8.23, 79.77],
  jaffna: [9.66, 80.02],
  haputale: [6.77, 80.96],
  kitulgala: [6.99, 80.41],
  nilaveli: [8.7, 81.19],
  ahangama: [5.97, 80.36],
  hiriketiya: [5.96, 80.69],
  'horton plains': [6.8, 80.8],
};

// Display names for the known places (each normalizes to a COORDS key above). The internal quoting
// tool offers these for offline autocomplete, so distance resolves even without a Google key.
export const KNOWN_PLACES: string[] = [
  'Colombo Airport (CMB)', 'Colombo City', 'Negombo', 'Bentota', 'Hikkaduwa', 'Galle', 'Weligama',
  'Mirissa', 'Kandy', 'Nuwara Eliya', 'Ella', 'Sigiriya / Dambulla', 'Anuradhapura', 'Yala',
  'Arugam Bay', 'Trincomalee',
  // Multi-stop via-stops (Phase 2 §5 catalog pre-check).
  'Polonnaruwa', 'Habarana', 'Nilaveli Beach', 'Nanu Oya', 'Thanthirimale',
  // Front-end catalogue parity (2026-08-12): every town transfers-data.js resolves.
  'Dambulla', 'Udawalawe', 'Tissamaharama', 'Tangalle', 'Unawatuna', 'Pasikudah',
  'Hatton', "Adam's Peak", 'Wilpattu', 'Kalpitiya', 'Jaffna', 'Haputale', 'Kitulgala',
  'Nilaveli', 'Ahangama', 'Hiriketiya', 'Horton Plains',
];

const norm = (s: string): string => s.trim().toLowerCase();

// Place identity for catalog lookups. Google's autocomplete hands back descriptions
// ("Yala, Sri Lanka"), while the catalog is keyed on the bare name ("Yala") — an exact
// match therefore MISSED, the coords pin below never applied, and the bare string went to
// Google's geocoder, which resolved "Yala" to a village near Horana instead of the national
// park. That priced a leg at 78 km instead of ~286 and sent a quote out $90 under
// (incident 2026-08-02). Strip the country suffix so both spellings are the same place.
export function canonPlace(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*sri lanka\s*$/, '')
    .trim();
}

// A road can never be shorter than the straight line between its endpoints, so for a pair of
// KNOWN places we hold an independent lower bound on any answer Google gives. This is the
// guard MAX_SL_ROAD_KM cannot be: that one rejects a geocode that landed in another country
// (too long), while a geocode that lands in the wrong Sri Lankan town comes back too SHORT —
// and short is the direction that silently undercharges. 0.95 absorbs the imprecision of the
// single-point coordinates below; it is not a tuning knob for "roughly right" answers.
const MIN_ROAD_TO_CROW = 0.95;

// Exported for the place resolver, which measures a candidate geocode against already-trusted
// points, and for the implausibly-short guard below.
export function haversineKm(a: [number, number], b: [number, number]): number {
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
  return parseLatLng(name) ?? COORDS[canonPlace(name)] ?? null;
}

// A name the coordinate catalogue recognises — the ONLY endpoints allowed to mint distance-cache
// rows. Excludes raw "lat,lng" strings deliberately: coordinates have unbounded cardinality and a
// cache keyed on them would grow per-customer, not per-town.
export function isCatalogTown(name: string): boolean {
  return COORDS[canonPlace(name)] !== undefined;
}

// A literal "lat,lng" is already a positively-identified point — that is how the place resolver
// hands a confirmed place to this adapter. Recognising it here is what makes the pin AND the
// implausibly-short floor guard apply to every resolved stop, not just to catalog towns: without
// it, passing coordinates would sail past the very check they exist to enable.
function parseLatLng(s: string): [number, number] | null {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
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

// A catalog place now reaches the adapters as its exact "lat,lng" (the place resolver hands
// over coordinates, never a re-geocodable name). The dev/e2e variant table is keyed on names,
// so map an exact catalog coordinate back to its key — otherwise keyless dev silently loses the
// scripted route-choice pairs the moment resolution is switched on.
function coordKey(s: string): string {
  const p = parseLatLng(s);
  if (!p) return canonPlace(s);
  for (const [key, c] of Object.entries(COORDS)) {
    if (c[0] === p[0] && c[1] === p[1]) return key;
  }
  return canonPlace(s);
}

function fakeVariantPair(from: string, to: string): RouteVariants | null {
  const a = coordKey(from);
  const b = coordKey(to);
  for (const [x, y, fastest, noTolls] of FAKE_VARIANT_PAIRS) {
    if ((a === x && b === y) || (a === y && b === x)) {
      // Same gate as the real adapter, so keyless dev never shows a fork prod would suppress.
      const hasChoice = isMaterialRouteChoice(fastest, noTolls);
      return { fastest, noTolls: hasChoice ? noTolls : null, hasChoice };
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

  // Keyless dev/test: only a catalog place has a coordinate. Anything else is genuinely
  // unknown here, which is the honest answer — and it exercises the confirmation path.
  async geocode(query: string): Promise<GeocodedPoint | null> {
    const c = knownCoords(query);
    return c ? { lat: c[0], lng: c[1], displayName: query.trim(), area: null } : null;
  }

  async placeCandidates(query: string): Promise<GeocodedPoint[]> {
    const names = await this.places(query);
    return names
      .map((n): GeocodedPoint | null => {
        const c = knownCoords(n);
        return c ? { lat: c[0], lng: c[1], displayName: n, area: null } : null;
      })
      .filter((p): p is GeocodedPoint => p !== null);
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
    const live = await this.googleDistance(from, to);
    if (live) return live;
    // Google is down, out of quota, denied, or returned nothing. Still return the estimate for
    // callers that only want a rough figure, but mark it so pricing refuses to charge on it.
    const off = offlineEstimate(from, to);
    return off ? { ...off, estimated: true } : null;
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
    const hasChoice = !!fast && !!slow && isMaterialRouteChoice(fast, slow);
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
    // Too SHORT to be real (see MIN_ROAD_TO_CROW). Only checkable when both endpoints are
    // known places, because only then do we have coordinates Google didn't give us. Returning
    // null hands the caller the offline estimate flagged `estimated`, so pricing declines to
    // charge on it rather than quietly billing a wrong-town distance.
    if (o && d) {
      const crowKm = haversineKm(o, d);
      if (km < crowKm * MIN_ROAD_TO_CROW) {
        console.error(
          `[maps] implausibly short distance ${km} km for "${from}" → "${to}" — below the ${Math.round(crowKm)} km straight line between them; treating as unresolved (likely a bad geocode inside Sri Lanka)`,
        );
        return null;
      }
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

  // Geocoding, used ONLY to test a string against places already trusted (see PlaceResolver).
  // A catalog place short-circuits: we already hold its verified coordinate, and asking Google
  // for one we have is both a wasted call and a chance to drift.
  async geocode(query: string): Promise<GeocodedPoint | null> {
    const known = knownCoords(query);
    if (known) return { lat: known[0], lng: known[1], displayName: query.trim(), area: null };
    const results = await this.geocodeAll(query);
    return results[0] ?? null;
  }

  async placeCandidates(query: string): Promise<GeocodedPoint[]> {
    return (await this.geocodeAll(query)).slice(0, 6);
  }

  private async geocodeAll(query: string): Promise<GeocodedPoint[]> {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json' +
      `?address=${encodeURIComponent(query)}&region=lk&components=country:LK&key=${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch {
      console.error('[maps] geocode error: fetch failed or timed out');
      return [];
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.error(`[maps] geocode error: HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as {
      status?: string;
      results?: {
        formatted_address?: string;
        geometry?: { location?: { lat: number; lng: number } };
        address_components?: { long_name: string; types: string[] }[];
      }[];
    };
    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('[maps] geocode error: ' + data.status);
      return [];
    }
    return (data.results || [])
      .map((r): GeocodedPoint | null => {
        const loc = r.geometry?.location;
        if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
        const area =
          r.address_components?.find((c) => c.types.includes('administrative_area_level_1'))?.long_name ?? null;
        return { lat: loc.lat, lng: loc.lng, displayName: r.formatted_address || query.trim(), area };
      })
      .filter((p): p is GeocodedPoint => p !== null);
  }
}
