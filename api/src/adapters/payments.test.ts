import { describe, it, expect } from 'vitest';
import { FakePaymentAdapter } from './payments';

describe('FakePaymentAdapter', () => {
  it('creates checkout params echoing order, amount and currency', async () => {
    const a = new FakePaymentAdapter();
    const p = await a.createCheckout({ orderId: 'CH-ABC12', amount: 5000, currency: 'USD' });
    expect(p.orderId).toBe('CH-ABC12');
    expect(p.amount).toBe(5000);
    expect(p.currency).toBe('USD');
    expect(p.checkoutUrl).toContain('CH-ABC12');
  });

  it('round-trips a signed webhook it produced', () => {
    const a = new FakePaymentAdapter();
    const body = a.simulateWebhook({ orderId: 'CH-ABC12', amount: 5000, currency: 'USD' });
    const event = a.parseWebhook(body);
    expect(event?.orderId).toBe('CH-ABC12');
    expect(event?.status).toBe('succeeded');
  });

  it('rejects a tampered webhook (bad signature)', () => {
    const a = new FakePaymentAdapter();
    const body = a.simulateWebhook({ orderId: 'CH-ABC12', amount: 5000, currency: 'USD' });
    expect(a.parseWebhook(body.replace('5000', '9999'))).toBeNull();
  });

  // Its signing key is a constant in this repo, so a fake adapter reaching production would let
  // anyone sign a "succeeded" webhook and mark a booking paid. config.ts refuses to boot without
  // PayHere credentials; this is the second lock against direct construction.
  it('refuses to construct in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FakePaymentAdapter()).toThrow(/never be used in production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
