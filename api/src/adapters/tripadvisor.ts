// Tripadvisor Content API (spec 2026-10-06 D22). Rating and review count are fetched LIVE on every
// request and never stored or cached - Tripadvisor's terms allow keeping only the location id. The
// bubble image and the listing link must be served from Tripadvisor's own URLs, so both are passed
// through (after a host check) rather than rebuilt.
//
// The real adapter is selected at startup only when TRIPADVISOR_API_KEY is set; otherwise the null
// adapter answers nothing and no rating is shown anywhere (CLAUDE.md hard rule 4). Every failure is
// `null`: a rating is decoration and must never break, or slow, the page it decorates.

export interface TripadvisorDetails {
  rating: number;
  numReviews: number;
  ratingImageUrl: string;
  webUrl: string;
}

export interface TripadvisorAdapter {
  details(locationId: string): Promise<TripadvisorDetails | null>;
}

const TIMEOUT_MS = 2000;
const BASE = 'https://api.content.tripadvisor.com/api/v1/location';

// https only, and only Tripadvisor's own hosts (www./static./… under tripadvisor.com or tacdn.com).
// A leading dot in the test is what keeps `eviltripadvisor.com` and `tripadvisor.com.evil.example` out.
function tripadvisorUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const ok = ['tripadvisor.com', 'tacdn.com'].some((d) => host === d || host.endsWith('.' + d));
  return ok ? u.toString() : null;
}

export class HttpTripadvisorAdapter implements TripadvisorAdapter {
  // The key is domain-restricted in Tripadvisor's console, so server calls say which site they speak for.
  constructor(private readonly apiKey: string, private readonly referer: string) {}

  async details(locationId: string): Promise<TripadvisorDetails | null> {
    if (!/^[0-9]{1,15}$/.test(locationId)) return null;
    const url = `${BASE}/${locationId}/details?key=${encodeURIComponent(this.apiKey)}&language=en&currency=USD`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', Referer: this.referer }, signal: ctrl.signal });
      if (res.status !== 200) return null;
      const j = (await res.json()) as Record<string, unknown>;
      const rating = typeof j.rating === 'string' && j.rating.trim() !== '' ? Number(j.rating) : j.rating;
      const reviews = typeof j.num_reviews === 'string' && j.num_reviews.trim() !== '' ? Number(j.num_reviews.replace(/,/g, '')) : j.num_reviews;
      const ratingImageUrl = tripadvisorUrl(j.rating_image_url);
      const webUrl = tripadvisorUrl(j.web_url);
      if (typeof rating !== 'number' || !(rating >= 0 && rating <= 5)) return null;
      if (typeof reviews !== 'number' || !Number.isInteger(reviews) || reviews < 0) return null;
      if (!ratingImageUrl || !webUrl) return null;
      return { rating, numReviews: reviews, ratingImageUrl, webUrl };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class NullTripadvisorAdapter implements TripadvisorAdapter {
  async details(): Promise<null> { return null; }
}

export class FakeTripadvisorAdapter implements TripadvisorAdapter {
  readonly calls: string[] = [];
  delayMs = 0;
  constructor(public byId: Record<string, TripadvisorDetails | null> = {}) {}
  async details(locationId: string): Promise<TripadvisorDetails | null> {
    this.calls.push(locationId);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.byId[locationId] ?? null;
  }
}
