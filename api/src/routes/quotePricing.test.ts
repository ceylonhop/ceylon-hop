import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { buildPricingPayload } from '../quote/pricingPayload';
import { RATE_CARD } from '../quote/rateCard';

// The site's live price list (spec 2026-09-26 §8.4, consumed by transfers-data.js in PR 3).
describe('GET /quote/pricing', () => {
  it('with nothing saved, is exactly the list the site bakes in today', async () => {
    const res = await createApp().request('/quote/pricing');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual(buildPricingPayload());
  });

  it('carries the founder\'s saved prices', async () => {
    const rateRevisions = new InMemoryRateRevisionRepo();
    const rates = ratesFromCard(RATE_CARD);
    await rateRevisions.create({ rates: { ...rates, perKmCents: { ...rates.perKmCents, car: 45 } }, baseVersion: null, createdBy: 'f@x.com' });
    const body = await (await createApp({ rateRevisions }).request('/quote/pricing')).json();
    expect(body.perKm.car).toBe(0.45);
  });

  it('never exposes costs or markup', async () => {
    const text = await (await createApp().request('/quote/pricing')).text();
    expect(text).not.toMatch(/cost|markup|margin/i);
  });

  it('answers the live site cross-origin', async () => {
    const res = await createApp({ allowedOrigins: ['https://ceylonhop.com'] }).request('/quote/pricing', { headers: { origin: 'https://ceylonhop.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ceylonhop.com');
  });
});
