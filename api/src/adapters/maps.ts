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
}

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
}

// Real adapter: Google Distance Matrix (driving). Resolves names/addresses server-side.
export class GoogleMapsAdapter implements MapsAdapter {
  readonly provider = 'google';
  constructor(private readonly apiKey: string) {}

  async distance(from: string, to: string): Promise<DistanceResult | null> {
    const url =
      'https://maps.googleapis.com/maps/api/distancematrix/json' +
      `?origins=${encodeURIComponent(from)}&destinations=${encodeURIComponent(to)}` +
      `&mode=driving&key=${this.apiKey}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json()) as {
      rows?: { elements?: { status?: string; distance?: { value: number }; duration?: { value: number } }[] }[];
    };
    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK' || !el.distance || !el.duration) return null;
    return { km: Math.round(el.distance.value / 1000), durationMin: Math.round(el.duration.value / 60) };
  }
}
