import type { UsageMeter } from '../services/usageMeter';

// "Find the business on Google" (2026-10-18): the ops Experiences form searches Google Places for the
// partner and fills partner, area, pin and contact from the pick. Server-side, on the same key as the
// quote tool's autocomplete (GOOGLE_MAPS_API_KEY), so the key never reaches a browser. Kept apart from
// MapsAdapter: quoting depends on that one, and this is ops-only.
//
// Every failure is "no results" ([] / null): the form then says so and ops types the details by hand.
// Details asks only for the fields the form fills (Places bills by field group); never photos or
// reviews, which Google's terms don't let us re-host.

export interface BusinessCandidate { placeId: string; name: string; address: string; lat: number; lng: number }
export interface BusinessDetails extends BusinessCandidate {
  area: string | null;
  phone: string | null;
  website: string | null;
  mapsUrl: string | null;
  /** Days with an opening in Google's hours (0 = Sunday, as ours); null when Google has no hours. */
  openWeekdays: number[] | null;
}
export interface BusinessPlacesAdapter {
  search(query: string): Promise<BusinessCandidate[]>;
  details(placeId: string): Promise<BusinessDetails | null>;
  /** Coordinates only — the daily pin refresh (Places lat/lng may be kept 30 days, Service Specific Terms §14.3). */
  location(placeId: string): Promise<{ lat: number; lng: number } | null>;
}

const BASE = 'https://maps.googleapis.com/maps/api/place';
const TIMEOUT_MS = 4000;
const MAX_RESULTS = 5;
// The shape migration 0074 checks; the id is spliced into a URL, so nothing else gets through.
export const PLACE_ID = /^[A-Za-z0-9_-]{10,255}$/;
const DETAIL_FIELDS = 'place_id,name,formatted_address,geometry/location,address_component,international_phone_number,website,url,opening_hours';
const LOCATION_FIELDS = 'place_id,geometry/location';

// Sri Lanka's bounding box, the same one ExperienceInputSchema enforces for lat/lng.
const inSriLanka = (lat: number, lng: number) => lat >= 5.8 && lat <= 10.0 && lng >= 79.4 && lng <= 82.0;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const httpUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
};

type GoogleResult = {
  place_id?: unknown; name?: unknown; formatted_address?: unknown;
  geometry?: { location?: { lat?: unknown; lng?: unknown } };
  address_components?: Array<{ long_name?: unknown; types?: unknown }>;
  international_phone_number?: unknown; website?: unknown; url?: unknown;
  opening_hours?: { periods?: Array<{ open?: { day?: unknown; time?: unknown }; close?: unknown }> };
};

// Google's periods use 0 = Sunday, the same numbering as openWeekdays. Open 24/7 is one period that opens
// on day 0 at 0000 with no close.
function openDaysOf(r: GoogleResult): number[] | null {
  const periods = r.opening_hours && Array.isArray(r.opening_hours.periods) ? r.opening_hours.periods : [];
  if (!periods.length) return null;
  if (periods.length === 1 && periods[0]!.open?.day === 0 && periods[0]!.open?.time === '0000' && !periods[0]!.close) return [0, 1, 2, 3, 4, 5, 6];
  const days = periods.map((p) => p.open?.day).filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6);
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
}

function toCandidate(r: GoogleResult): BusinessCandidate | null {
  const placeId = typeof r.place_id === 'string' && PLACE_ID.test(r.place_id) ? r.place_id : null;
  const name = str(r.name, 80);
  const lat = r.geometry?.location?.lat, lng = r.geometry?.location?.lng;
  if (!placeId || !name || typeof lat !== 'number' || typeof lng !== 'number' || !inSriLanka(lat, lng)) return null;
  return { placeId, name, address: str(r.formatted_address, 200) ?? '', lat, lng };
}

// The town a traveller would recognise: Google's locality ("Sigiriya"), else the sublocality.
function areaOf(r: GoogleResult): string | null {
  const parts = Array.isArray(r.address_components) ? r.address_components : [];
  for (const want of ['locality', 'sublocality', 'administrative_area_level_2']) {
    const hit = parts.find((p) => Array.isArray(p.types) && p.types.includes(want));
    const name = hit && str(hit.long_name, 40);
    if (name) return name;
  }
  return null;
}

export class GoogleBusinessPlaces implements BusinessPlacesAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly meter?: Pick<UsageMeter, 'bump'>,
  ) {}

  async search(query: string): Promise<BusinessCandidate[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const url = `${BASE}/textsearch/json?query=${encodeURIComponent(q)}&region=lk&key=${encodeURIComponent(this.apiKey)}`;
    const data = await this.get(url, 'maps.business_search');
    if (!data || data.status !== 'OK' || !Array.isArray(data.results)) return [];
    return (data.results as GoogleResult[]).map(toCandidate).filter((c): c is BusinessCandidate => c !== null).slice(0, MAX_RESULTS);
  }

  async details(placeId: string): Promise<BusinessDetails | null> {
    if (!PLACE_ID.test(placeId)) return null;
    const url = `${BASE}/details/json?place_id=${encodeURIComponent(placeId)}&fields=${encodeURIComponent(DETAIL_FIELDS)}&key=${encodeURIComponent(this.apiKey)}`;
    const data = await this.get(url, 'maps.business_details');
    if (!data || data.status !== 'OK' || !data.result) return null;
    const r = data.result as GoogleResult;
    const c = toCandidate(r);
    if (!c) return null;
    return { ...c, area: areaOf(r), phone: str(r.international_phone_number, 40), website: httpUrl(r.website), mapsUrl: httpUrl(r.url), openWeekdays: openDaysOf(r) };
  }

  async location(placeId: string): Promise<{ lat: number; lng: number } | null> {
    if (!PLACE_ID.test(placeId)) return null;
    const url = `${BASE}/details/json?place_id=${encodeURIComponent(placeId)}&fields=${encodeURIComponent(LOCATION_FIELDS)}&key=${encodeURIComponent(this.apiKey)}`;
    const data = await this.get(url, 'maps.business_location');
    const loc = data && data.status === 'OK' ? (data.result as GoogleResult | undefined)?.geometry?.location : undefined;
    const lat = loc?.lat, lng = loc?.lng;
    return typeof lat === 'number' && typeof lng === 'number' && inSriLanka(lat, lng) ? { lat, lng } : null;
  }

  // Counted before the call, like MeteredMapsAdapter: a call that fails was still billed.
  private async get(url: string, meterKey: string): Promise<{ status?: unknown; results?: unknown; result?: unknown } | null> {
    this.meter?.bump(meterKey);
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) { console.error(`[places] ${meterKey} HTTP ${res.status}`); return null; }
      const data = (await res.json()) as { status?: unknown; error_message?: unknown };
      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') console.error(`[places] ${meterKey} ${String(data.status)}`);
      return data;
    } catch {
      console.error(`[places] ${meterKey} failed or timed out`);
      return null;
    }
  }
}

export class FakeBusinessPlaces implements BusinessPlacesAdapter {
  readonly calls: string[] = [];
  constructor(private readonly places: BusinessDetails[] = []) {}
  async search(query: string): Promise<BusinessCandidate[]> {
    this.calls.push(`search:${query}`);
    const q = query.toLowerCase();
    return this.places.filter((p) => p.name.toLowerCase().includes(q))
      .map(({ placeId, name, address, lat, lng }) => ({ placeId, name, address, lat, lng }));
  }
  async details(placeId: string): Promise<BusinessDetails | null> {
    this.calls.push(`details:${placeId}`);
    const hit = this.places.find((p) => p.placeId === placeId);
    return hit ? { ...hit } : null;
  }
  async location(placeId: string): Promise<{ lat: number; lng: number } | null> {
    this.calls.push(`location:${placeId}`);
    const hit = this.places.find((p) => p.placeId === placeId);
    return hit ? { lat: hit.lat, lng: hit.lng } : null;
  }
}

// Off (null) without a key: the form hides the search and ops types the details, as before.
export function selectBusinessPlaces(apiKey: string | undefined, meter?: Pick<UsageMeter, 'bump'>): BusinessPlacesAdapter | null {
  return apiKey ? new GoogleBusinessPlaces(apiKey, fetch, meter) : null;
}
