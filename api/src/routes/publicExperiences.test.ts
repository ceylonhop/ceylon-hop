import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { ExperienceInputSchema } from '../experiences/experience';
import { aboutKm } from '../experiences/experience';
import { haversineKm } from '../adapters/maps';
import { FakeTripadvisorAdapter, NullTripadvisorAdapter, type TripadvisorDetails } from '../adapters/tripadvisor';

const base = {
  partnerName: 'Atherya Spa', summary: 'A massage', priceCents: 3500, priceUnit: 'per_person' as const,
  openWeekdays: [1], startTimes: ['09:00'], radiusKm: 5, partnerContact: 'secret-contact-+94770000000',
};
async function seed(repo: InMemoryExperienceRepo) {
  const mk = (o: Record<string, unknown>) => repo.create({ ...ExperienceInputSchema.parse({ ...base, ...o }), createdBy: 'secret-creator@x.com' });
  const near = await mk({ slug: 'near-spa', name: 'Near spa', areaLabel: 'Sigiriya', lat: 7.977, lng: 80.76, photos: ['guides/sigiriya/ayurveda'] });
  const nearer = await mk({ slug: 'nearer-cook', name: 'Nearer cooking', areaLabel: 'Sigiriya', lat: 7.951, lng: 80.761 });
  const off = await mk({ slug: 'off-spa', name: 'Switched off', areaLabel: 'Sigiriya', lat: 7.95, lng: 80.76, active: false });
  const kandy = await mk({ slug: 'kandy-tour', name: 'Kandy tour', areaLabel: 'Kandy', lat: 7.2906, lng: 80.6337 });
  return { near, nearer, off, kandy };
}
async function setup(deps: AppDeps = {}) {
  const experiences = new InMemoryExperienceRepo();
  const seeded = await seed(experiences);
  const a = realCreateApp({ adminApiKey: 'k', experiences, allowedOrigins: ['https://ceylonhop.com'], ...deps });
  return { a, ...seeded };
}
const q = (...at: string[]) => `/experiences/near?${at.map((x) => `at=${encodeURIComponent(x)}`).join('&')}`;

describe('GET /experiences/near', () => {
  it('groups by stop in request order, nearest first, active only', async () => {
    const { a, near, nearer, kandy, off } = await setup();
    const res = await a.request(q('Sigiriya@7.95,80.76', 'Kandy@7.2906,80.6337'));
    expect(res.status).toBe(200);
    const { stops } = await res.json();
    expect(stops.map((s: { place: string }) => s.place)).toEqual(['Sigiriya', 'Kandy']);
    expect(stops[0].items.map((i: { id: string }) => i.id)).toEqual([nearer.id, near.id]);
    expect(stops[1].items.map((i: { id: string }) => i.id)).toEqual([kandy.id]);
    expect(JSON.stringify(stops)).not.toContain(off.id);
  });

  it('aboutKm is the road-factor distance; photos are absolute URLs', async () => {
    const { a, near } = await setup();
    const { stops } = await (await a.request(q('Sigiriya@7.95,80.76'))).json();
    const item = stops[0].items.find((i: { id: string }) => i.id === near.id);
    expect(item.aboutKm).toBe(aboutKm(haversineKm([7.95, 80.76], [7.977, 80.76])));
    expect(item.photos).toEqual([{ small: 'https://ceylonhop.com/img/guides/sigiriya/ayurveda-900.jpg', large: 'https://ceylonhop.com/img/guides/sigiriya/ayurveda-1800.jpg' }]);
  });

  it('never exposes the partner contact, the pin or the audit trail', async () => {
    const { a } = await setup();
    const text = await (await a.request(q('Sigiriya@7.95,80.76'))).text();
    expect(text).not.toContain('secret-contact');
    expect(text).not.toContain('secret-creator');
    expect(text).not.toContain('partnerContact');
    expect(text).not.toContain('createdBy');
    expect(text).not.toContain('"lat"');
    expect(text).not.toContain('"lng"');
  });

  it('a stop with nothing near is simply absent; sets a 5-minute public cache', async () => {
    const { a } = await setup();
    const res = await a.request(q('Galle@6.0329,80.217'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await res.json()).toEqual({ stops: [] });
  });

  it('400 for missing, malformed, out-of-box or too many at', async () => {
    const { a } = await setup();
    const bad = [
      '/experiences/near',
      q('Sigiriya'),
      q('Sigiriya@abc,def'),
      q('Sigiriya@80.76,7.95'), // lng,lat swapped: lands outside Sri Lanka
      q(`${'x'.repeat(61)}@7.95,80.76`),
      q('@7.95,80.76'),
      q(...Array.from({ length: 9 }, (_, i) => `S${i}@7.95,80.76`)),
    ];
    for (const url of bad) {
      const res = await a.request(url);
      expect(res.status, url).toBe(400);
      expect((await res.json()).error).toBe('bad_request');
    }
    expect((await a.request(q(...Array.from({ length: 8 }, (_, i) => `S${i}@7.95,80.76`)))).status).toBe(200);
  });

  it('is CORS-readable from the site origin', async () => {
    const { a } = await setup();
    const res = await a.request(q('Sigiriya@7.95,80.76'), { headers: { origin: 'https://ceylonhop.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ceylonhop.com');
  });

  it('is rate limited per IP on GET (429 past the budget)', async () => {
    const { a } = await setup({ rateLimit: { max: 3, windowMs: 60_000 } });
    const hit = () => a.request(q('Sigiriya@7.95,80.76'), { headers: { 'x-forwarded-for': '203.0.113.9' } });
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
});

// D22: live Tripadvisor ratings. Fetched per request, never stored or cached (Tripadvisor's terms).
const DETAILS: TripadvisorDetails = {
  rating: 4.5, numReviews: 312,
  ratingImageUrl: 'https://www.tripadvisor.com/img/cdsi/img2/ratings/traveler/4.5-12345-5.svg',
  webUrl: 'https://www.tripadvisor.com/Attraction_Review-g1-d6789012-Reviews-Spa.html',
};
async function ratingsSetup(deps: AppDeps = {}) {
  const experiences = new InMemoryExperienceRepo();
  const mk = (o: Record<string, unknown>) => experiences.create(ExperienceInputSchema.parse({ ...base, areaLabel: 'Sigiriya', lat: 7.95, lng: 80.76, ...o }));
  const rated = await mk({ slug: 'rated-spa', name: 'Rated spa', tripadvisorLocationId: '6789012' });
  const rated2 = await mk({ slug: 'rated-cook', name: 'Rated cooking', tripadvisorLocationId: '555' });
  const unlisted = await mk({ slug: 'unlisted', name: 'No listing' });
  const off = await mk({ slug: 'off-rated', name: 'Off', tripadvisorLocationId: '777', active: false });
  const tripadvisor = new FakeTripadvisorAdapter({ '6789012': DETAILS, '555': { ...DETAILS, rating: 5, numReviews: 9 }, '777': DETAILS });
  const a = realCreateApp({ adminApiKey: 'k', experiences, tripadvisor, allowedOrigins: ['https://ceylonhop.com'], ...deps });
  return { a, experiences, tripadvisor, rated, rated2, unlisted, off };
}
const rq = (...ids: string[]) => `/experiences/ratings?ids=${ids.join(',')}`;

describe('GET /experiences/ratings', () => {
  it('answers a rating per active, listed experience, in request order, with the fields the page needs', async () => {
    const { a, rated, rated2, tripadvisor } = await ratingsSetup();
    const res = await a.request(rq(rated2.id, rated.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ratings: [
      { id: rated2.id, rating: 5, numReviews: 9, ratingImageUrl: DETAILS.ratingImageUrl, webUrl: DETAILS.webUrl },
      { id: rated.id, rating: 4.5, numReviews: 312, ratingImageUrl: DETAILS.ratingImageUrl, webUrl: DETAILS.webUrl },
    ] });
    expect(tripadvisor.calls.sort()).toEqual(['555', '6789012']);
  });

  it('is never cached: cache-control no-store, and every request goes to Tripadvisor again', async () => {
    const { a, rated, tripadvisor } = await ratingsSetup();
    const first = await a.request(rq(rated.id));
    expect(first.headers.get('cache-control')).toBe('no-store');
    await a.request(rq(rated.id));
    expect(tripadvisor.calls).toEqual(['6789012', '6789012']);
  });

  it('leaves out inactive experiences, ones with no listing and unknown ids — and never asks Tripadvisor about them', async () => {
    const { a, rated, unlisted, off, tripadvisor } = await ratingsSetup();
    const { ratings } = await (await a.request(rq(rated.id, unlisted.id, off.id, '99999999-9999-4999-8999-999999999999'))).json();
    expect(ratings.map((r: { id: string }) => r.id)).toEqual([rated.id]);
    expect(tripadvisor.calls).toEqual(['6789012']);
  });

  it('leaves out an experience whose lookup failed (null), keeping the others', async () => {
    const { a, rated, rated2, tripadvisor } = await ratingsSetup();
    delete tripadvisor.byId['555'];
    const { ratings } = await (await a.request(rq(rated.id, rated2.id))).json();
    expect(ratings.map((r: { id: string }) => r.id)).toEqual([rated.id]);
  });

  it('looks the experiences up in parallel, not one after another', async () => {
    const { a, rated, rated2, tripadvisor } = await ratingsSetup();
    tripadvisor.delayMs = 120;
    const t0 = Date.now();
    const { ratings } = await (await a.request(rq(rated.id, rated2.id))).json();
    expect(ratings).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(220);
  });

  it('a repeated id is asked about once', async () => {
    const { a, rated, tripadvisor } = await ratingsSetup();
    const { ratings } = await (await a.request(rq(rated.id, rated.id))).json();
    expect(ratings).toHaveLength(1);
    expect(tripadvisor.calls).toEqual(['6789012']);
  });

  it('400 for no ids, a non-uuid, an empty entry, or more than 6', async () => {
    const { a, rated, tripadvisor } = await ratingsSetup();
    const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const bad = [
      '/experiences/ratings', '/experiences/ratings?ids=', rq('nope'), rq(rated.id, 'x'), `/experiences/ratings?ids=${rated.id},`,
      rq(...[1, 2, 3, 4, 5, 6, 7].map(uuid)), `/experiences/ratings?ids=${encodeURIComponent("' or 1=1 --")}`,
    ];
    for (const url of bad) {
      const res = await a.request(url);
      expect(res.status, url).toBe(400);
      expect((await res.json()).error).toBe('bad_request');
    }
    expect(tripadvisor.calls).toEqual([]);
    expect((await a.request(rq(...[1, 2, 3, 4, 5, 6].map(uuid)))).status).toBe(200);
  });

  it('with the Null adapter (no key) answers { ratings: [] } without touching the database', async () => {
    const { experiences, rated } = await ratingsSetup();
    const spy = { ...experiences, getMany: async () => { throw new Error('db touched'); }, listActive: async () => { throw new Error('db touched'); }, get: async () => { throw new Error('db touched'); } };
    const a = realCreateApp({ adminApiKey: 'k', experiences: spy as unknown as InMemoryExperienceRepo, tripadvisor: new NullTripadvisorAdapter() });
    const res = await a.request(rq(rated.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ratings: [] });
    // ...and that is also what an app built with no adapter at all does.
    const d = realCreateApp({ adminApiKey: 'k', experiences: spy as unknown as InMemoryExperienceRepo });
    expect(await (await d.request(rq(rated.id))).json()).toEqual({ ratings: [] });
  });

  it('never returns the location id, and /experiences/near still does not either', async () => {
    const { a, rated } = await ratingsSetup();
    expect(await (await a.request(rq(rated.id))).text()).not.toMatch(/"6789012"|locationId/i);
    const near = await (await a.request(q('Sigiriya@7.95,80.76'))).text();
    expect(near).toContain(rated.id);
    expect(near).not.toMatch(/6789012|ripadvisor/);
  });

  it('is CORS-readable from the site origin', async () => {
    const { a, rated } = await ratingsSetup();
    const res = await a.request(rq(rated.id), { headers: { origin: 'https://ceylonhop.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ceylonhop.com');
  });

  it('is rate limited per IP on GET and on HEAD (429 past the budget)', async () => {
    const { a, rated } = await ratingsSetup({ rateLimit: { max: 3, windowMs: 60_000 } });
    const hit = (method: string) => a.request(rq(rated.id), { method, headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect((await hit('GET')).status).toBe(200);
    expect((await hit('HEAD')).status).toBe(200);
    expect((await hit('GET')).status).toBe(200);
    expect((await hit('GET')).status).toBe(429);
    expect((await hit('HEAD')).status).toBe(429);
  });
});
