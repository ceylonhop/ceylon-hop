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

  // Pinned known-good signature: locks the md5sig algorithm + field ORDER against
  // regression. The literal was computed once for these exact inputs (md5sig =
  // UPPER(md5( MID + order + amount + currency + status_code + UPPER(md5(secret)) )));
  // any change to the production hashing makes parseWebhook recompute a different value,
  // reject this body, and fail this test. (A truly independent oracle = a captured real
  // sandbox notify; until then this prevents silent drift from the sandbox-verified algo.)
  it('accepts a body carrying a pinned, independently-computed md5sig', () => {
    const body = new URLSearchParams({
      merchant_id: MID,
      order_id: 'CH-LOCK1',
      payment_id: 'PAY-LOCK',
      payhere_amount: '40.00',
      payhere_currency: 'USD',
      status_code: '2',
      md5sig: 'E54BE7A7858B65FC8EEE345CA059AF9C',
    }).toString();
    const event = adapter().parseWebhook(body);
    expect(event).not.toBeNull();
    expect(event?.status).toBe('succeeded');
    expect(event?.amount).toBe(4000);
    expect(event?.orderId).toBe('CH-LOCK1');
  });

  it('rejects a forged md5sig (valid fields, attacker-chosen signature)', () => {
    const a = adapter();
    const valid = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    const forged = valid.replace(/md5sig=[A-F0-9]+/, 'md5sig=' + 'A'.repeat(32));
    expect(a.parseWebhook(forged)).toBeNull();
  });

  it('rejects a notify with no md5sig at all', () => {
    const noSig = new URLSearchParams({
      merchant_id: MID,
      order_id: 'CH-ABC12',
      payhere_amount: '40.00',
      payhere_currency: 'USD',
      status_code: '2',
    }).toString();
    expect(adapter().parseWebhook(noSig)).toBeNull();
  });

  it('rejects a tampered status_code (signed as failed, flipped to success)', () => {
    const a = adapter();
    const failed = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD', statusCode: '-2' });
    const forgedSuccess = failed.replace('status_code=-2', 'status_code=2');
    expect(a.parseWebhook(forgedSuccess)).toBeNull();
  });
});
