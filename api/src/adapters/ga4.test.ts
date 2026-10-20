import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeGa4Adapter, MeasurementProtocolAdapter, type Ga4Hit } from './ga4';

const HIT: Ga4Hit = {
  client_id: '1.2', timestamp_micros: 1, consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
  events: [{ name: 'purchase_server', params: { transaction_id: 'CH-1', value: 10, currency: 'USD' } }],
};

afterEach(() => vi.unstubAllGlobals());

describe('GA4 adapters', () => {
  it('the fake records hits and can be told to fail', async () => {
    const fake = new FakeGa4Adapter();
    fake.failNext = 1;
    await expect(fake.send(HIT)).rejects.toThrow('ga4_fake_failure');
    await fake.send(HIT);
    expect(fake.sent).toEqual([HIT]);
  });
  it('the Measurement Protocol adapter POSTs the hit to /mp/collect with id + secret', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response(null, { status: 204 });
    });
    await new MeasurementProtocolAdapter('G-TEST', 's3cret').send(HIT);
    expect(calls[0].url).toBe('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=s3cret');
    expect(JSON.parse(calls[0].body)).toEqual(HIT);
  });
  it('throws on a non-2xx answer so the ledger records a failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await expect(new MeasurementProtocolAdapter('G-TEST', 's').send(HIT)).rejects.toThrow('ga4_send_failed_500');
  });
});
