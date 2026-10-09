import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { ExperienceInputSchema } from '../experiences/experience';
import { aboutKm } from '../experiences/experience';
import { haversineKm } from '../adapters/maps';

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
