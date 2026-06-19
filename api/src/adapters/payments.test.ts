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
});
