import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PayHerePaymentAdapter } from './payhere';

const md5Upper = (s: string) => createHash('md5').update(s).digest('hex').toUpperCase();
const MID = '1234567';
const SECRET = 'test-secret';

function adapter() {
  return new PayHerePaymentAdapter(MID, SECRET, {
    mode: 'sandbox',
    notifyUrl: 'https://example.com/webhooks/payhere',
    returnUrl: 'https://site/return',
    cancelUrl: 'https://site/cancel',
  });
}

describe('PayHerePaymentAdapter', () => {
  it('builds sandbox checkout fields with the correct hash and 2dp amount', async () => {
    const p = await adapter().createCheckout({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    expect(p.checkoutUrl).toBe('https://sandbox.payhere.lk/pay/checkout');
    expect(p.fields?.amount).toBe('40.00');
    const expected = md5Upper(MID + 'CH-ABC12' + '40.00' + 'USD' + md5Upper(SECRET));
    expect(p.fields?.hash).toBe(expected);
    expect(p.fields?.merchant_id).toBe(MID);
    expect(p.fields?.notify_url).toBe('https://example.com/webhooks/payhere');
  });

  it('verifies a correctly-signed notify and maps status 2 -> succeeded', () => {
    const a = adapter();
    const body = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    const event = a.parseWebhook(body);
    expect(event?.status).toBe('succeeded');
    expect(event?.amount).toBe(4000); // 40.00 -> 4000 cents
    expect(event?.orderId).toBe('CH-ABC12');
  });

  it('rejects a tampered notify (bad md5sig)', () => {
    const a = adapter();
    const body = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    expect(a.parseWebhook(body.replace('40.00', '1.00'))).toBeNull();
  });

  it('maps a non-2 status to failed', () => {
    const a = adapter();
    const body = a.simulateNotify({ orderId: 'CH-X', amount: 4000, currency: 'USD', statusCode: '-2' });
    expect(a.parseWebhook(body)?.status).toBe('failed');
  });
});
