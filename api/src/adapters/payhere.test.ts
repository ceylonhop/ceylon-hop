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

function signedNotify(overrides: Partial<Record<
  'merchant_id' | 'order_id' | 'payment_id' | 'payhere_amount' | 'payhere_currency' | 'status_code',
  string
>> = {}): string {
  const fields = {
    merchant_id: MID,
    order_id: 'CH-ABC12',
    payment_id: 'PAY123',
    payhere_amount: '40.00',
    payhere_currency: 'USD',
    status_code: '2',
    ...overrides,
  };
  const md5sig = md5Upper(
    fields.merchant_id +
      fields.order_id +
      fields.payhere_amount +
      fields.payhere_currency +
      fields.status_code +
      md5Upper(SECRET),
  );
  return new URLSearchParams({ ...fields, md5sig }).toString();
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

  // Owner-caught 2026-08-01: these were hardcoded `address: 'N/A'`, `city: 'Colombo'` and went
  // out on every live charge — fabricated billing data, wrong in the payment record and a
  // plausible AVS decline on a foreign-issued card. Nothing asserted them, which is how they
  // survived. An OMITTED field lets PayHere collect the real one; a fake field cannot be.
  it('omits address/city entirely when the booking captured no billing details', async () => {
    const p = await adapter().createCheckout({
      orderId: 'CH-ABC12', amount: 4000, currency: 'USD',
      customer: { firstName: 'Nimal', lastName: 'Perera', email: 'n@x.com', phone: '+94770001111', country: 'Sri Lanka' },
    });
    expect(p.fields?.address).toBeUndefined();
    expect(p.fields?.city).toBeUndefined();
    expect(JSON.stringify(p.fields)).not.toContain('N/A');
    expect(JSON.stringify(p.fields)).not.toContain('Colombo');
  });

  it('sends the real billing address when one was captured', async () => {
    const p = await adapter().createCheckout({
      orderId: 'CH-ABC12', amount: 4000, currency: 'USD',
      customer: { firstName: 'Anja', lastName: 'de Vries', email: 'a@x.com', phone: '+31641256927',
        country: 'Netherlands', address: 'Prinsengracht 263', city: 'Amsterdam' },
    });
    expect(p.fields?.address).toBe('Prinsengracht 263');
    expect(p.fields?.city).toBe('Amsterdam');
    expect(p.fields?.country).toBe('Netherlands');
  });

  // 2026-08-02, PROD INCIDENT: address/city were removed on the theory that PayHere would
  // prompt for them. It does not — that is the HOSTED PAYMENT LINK product, not this JS SDK.
  // The SDK lists address/city/country as REQUIRED and fires payhere.onError on invalid
  // parameters, so the popup never opened at all and no one could pay. Worse than the
  // declines it was meant to fix. This asserts every field the SDK requires is present.
  it('sends every field the PayHere JS SDK requires — omitting one kills the popup', async () => {
    const p = await adapter().createCheckout({
      orderId: 'CH-ABC12', amount: 4000, currency: 'USD',
      customer: { firstName: 'Nimal', lastName: 'Perera', email: 'n@x.com', phone: '+94770001111',
        country: 'Sri Lanka', address: '221B Galle Road', city: 'Colombo' },
    });
    for (const f of ['merchant_id', 'order_id', 'items', 'amount', 'currency', 'hash',
                     'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'country']) {
      expect(p.fields?.[f], `PayHere requires ${f}`).toBeTruthy();
    }
  });

  // A postcode is the strongest AVS signal most issuers check, and PayHere has no parameter
  // for one — so it rides on the address line, which their docs define as "Address Line1 +
  // Line2" (free text). Dropping it would hand the acquirer the one part banks actually match
  // on, missing (owner, 2026-08-02).
  it('carries the postcode on the address line, since PayHere has no field for it', async () => {
    const p = await adapter().createCheckout({
      orderId: 'CH-ABC12', amount: 4000, currency: 'USD',
      customer: { firstName: 'R', lastName: 'W', email: 'r@x.com', phone: '+19176008055',
        country: 'United States', address: '31 River Court, Apt 105', city: 'Jersey City', postcode: '07310' },
    });
    expect(p.fields?.address).toBe('31 River Court, Apt 105, 07310');
    expect(p.fields?.city).toBe('Jersey City');
  });

  // US/CA payers were writing the state into the city box, because the form had no field for
  // it and `city` is what the gateway forwards as the city. It now joins the postcode on the
  // address line, in the order a US address is actually written.
  it('writes state and postcode onto the address line the way an address reads', async () => {
    const p = await adapter().createCheckout({
      orderId: 'CH-ABC12', amount: 2900, currency: 'USD',
      customer: { firstName: 'R', lastName: 'W', email: 'r@x.com', phone: '+13396540511',
        country: 'United States', address: '31 River Court, Apt 105', city: 'Jersey City',
        state: 'NJ', postcode: '07310' },
    });
    expect(p.fields?.address).toBe('31 River Court, Apt 105, NJ 07310');
    expect(p.fields?.city).toBe('Jersey City'); // and NOT 'Jersey City, NJ'
  });

  it('carries a state with no postcode, and a postcode with no state', async () => {
    const base = { orderId: 'CH-ABC12', amount: 2900, currency: 'USD' } as const;
    const c = { firstName: 'R', lastName: 'W', email: 'r@x.com', phone: '+1', country: 'United States',
      address: '31 River Court', city: 'Jersey City' };
    expect((await adapter().createCheckout({ ...base, customer: { ...c, state: 'NJ' } })).fields?.address)
      .toBe('31 River Court, NJ');
    expect((await adapter().createCheckout({ ...base, customer: { ...c, postcode: '07310' } })).fields?.address)
      .toBe('31 River Court, 07310');
  });

  it('leaves the address untouched when no postcode was given', async () => {
    const p = await adapter().createCheckout({
      orderId: 'CH-ABC12', amount: 4000, currency: 'USD',
      customer: { firstName: 'N', lastName: 'P', email: 'n@x.com', phone: '+94770001111',
        country: 'Sri Lanka', address: '221B Galle Road', city: 'Colombo' },
    });
    expect(p.fields?.address).toBe('221B Galle Road');
  });

  it('verifies a correctly-signed notify and maps status 2 -> succeeded', () => {
    const a = adapter();
    const body = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    const event = a.parseWebhook(body);
    expect(event?.status).toBe('succeeded');
    expect(event?.amountCents).toBe(4000); // 40.00 -> 4000 cents
    expect(event?.orderId).toBe('CH-ABC12');
    expect(event).toMatchObject({
      provider: 'payhere',
      merchantId: MID,
      providerTxnId: 'PAY123',
      currency: 'USD',
      providerStatusCode: '2',
    });
    expect(event?.receivedAt).toBeInstanceOf(Date);
    expect(event?.payloadSha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(event?.sanitizedPayload).not.toHaveProperty('md5sig');
  });

  it('keeps the decline reason and payment method PayHere sends alongside a failure', () => {
    // A production decline (order CH-4KU9Z, status -2) told us nothing beyond "-2": PayHere sends
    // status_message and method on every notify and we were dropping both, so the only place the
    // reason existed was their dashboard. Both are non-PII.
    const a = adapter();
    const signed = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD', statusCode: '-2' });
    const body = `${signed}&status_message=${encodeURIComponent('Do not honor')}&method=VISA`;
    const event = a.parseWebhook(body);
    expect(event?.status).toBe('failed');
    expect(event?.sanitizedPayload).toMatchObject({ status_message: 'Do not honor', method: 'VISA' });
  });

  it('omits the diagnostic fields when PayHere does not send them, and never card PII', () => {
    const a = adapter();
    const signed = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    // card_holder_name / card_no / card_expiry ride along on real card payments. They are PII and
    // this table is the sanitized log — they must not be stored here.
    const body = `${signed}&card_holder_name=${encodeURIComponent('Roshen Weliwatta')}&card_no=************4564&card_expiry=0122`;
    const event = a.parseWebhook(body);
    expect(event?.sanitizedPayload).not.toHaveProperty('status_message');
    expect(event?.sanitizedPayload).not.toHaveProperty('method');
    expect(event?.sanitizedPayload).not.toHaveProperty('card_holder_name');
    expect(event?.sanitizedPayload).not.toHaveProperty('card_no');
    expect(event?.sanitizedPayload).not.toHaveProperty('card_expiry');
  });

  it('truncates a long status_message rather than storing it unbounded', () => {
    const a = adapter();
    const signed = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD', statusCode: '-2' });
    const event = a.parseWebhook(`${signed}&status_message=${'x'.repeat(500)}`);
    expect(event?.sanitizedPayload.status_message).toHaveLength(200);
  });

  it('rejects a tampered notify (bad md5sig)', () => {
    const a = adapter();
    const body = a.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    expect(a.parseWebhook(body.replace('40.00', '1.00'))).toBeNull();
  });

  it.each([
    ['2', 'succeeded'],
    ['0', 'pending'],
    ['-1', 'cancelled'],
    ['-2', 'failed'],
    ['-3', 'charged_back'],
  ] as const)('maps PayHere status %s -> %s', (statusCode, status) => {
    expect(adapter().parseWebhook(signedNotify({ status_code: statusCode }))?.status).toBe(status);
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
    expect(event?.amountCents).toBe(4000);
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

  it('rejects a correctly signed notification for a different merchant', () => {
    expect(adapter().parseWebhook(signedNotify({ merchant_id: '7654321' }))).toBeNull();
  });

  it('leaves a signed three-letter currency for stored-payment reconciliation', () => {
    const event = adapter().parseWebhook(signedNotify({ payhere_currency: 'EUR' }));
    expect(event?.currency).toBe('EUR');
  });

  it.each(['usd', 'US', 'USDD', 'U1D'])('rejects malformed currency %s', (currency) => {
    expect(adapter().parseWebhook(signedNotify({ payhere_currency: currency }))).toBeNull();
  });

  it.each(['NaN', '40', '40.0', '0.00', '-1.00', '1e2', '1000000000.00'])(
    'rejects malformed, non-positive, or oversized amount %s',
    (amount) => {
      expect(adapter().parseWebhook(signedNotify({ payhere_amount: amount }))).toBeNull();
    },
  );

  it('rejects a missing provider transaction id', () => {
    expect(adapter().parseWebhook(signedNotify({ payment_id: '' }))).toBeNull();
  });

  it('rejects duplicate security-critical fields', () => {
    const body = `${signedNotify()}&order_id=CH-OTHER`;
    expect(adapter().parseWebhook(body)).toBeNull();
  });

  it('rejects an unknown PayHere status code', () => {
    expect(adapter().parseWebhook(signedNotify({ status_code: '9' }))).toBeNull();
  });

  it('rejects an oversized webhook body before parsing', () => {
    const body = `${signedNotify()}&padding=${'x'.repeat(9_000)}`;
    expect(adapter().parseWebhook(body)).toBeNull();
  });
});
