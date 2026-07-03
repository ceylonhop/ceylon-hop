// Maps adapter (M8): road distance + driving duration between two places.
// External service behind an adapter with a fake — the fake is used in tests and whenever
// no Google key is configured; the real Google adapter is config-selected on the server.

export interface DistanceResult {
  km: number;
  durationMin: number;
}

export interface MapsAdapter {
  readonly provider: string;
  // Returns null when the route can't be resolved (e.g. the fake doesn't know a typed address).
  distance(from: string, to: string): Promise<DistanceResult | null>;
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

export class FakeMapsAdapter implements MapsAdapter {
  readonly provider = 'fake';
  async distance(from: string, to: string): Promise<DistanceResult | null> {
    const a = COORDS[norm(from)];
    const b = COORDS[norm(to)];
    if (!a || !b) return null;
    const km = Math.round(haversineKm(a, b) * 1.35);
    return { km, durationMin: Math.round((km / 42) * 60) };
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

  async distance(from: string, to: string): Promise<DistanceResult | null> {
    const url =
      'https://maps.googleapis.com/maps/api/distancematrix/json' +
      `?origins=${encodeURIComponent(from)}&destinations=${encodeURIComponent(to)}` +
      `&mode=driving&region=lk&key=${this.apiKey}`;
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
      return [];
    }
    const out = (data.predictions || []).slice(0, 6).map((p) => p.description);
    if (out.length) return out;
    return offlineFallback();
  }
}
