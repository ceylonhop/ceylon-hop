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

// A rejected notify used to be indistinguishable from a bot probing the public endpoint: both
// produced `parseWebhook -> null` and an alert blaming the merchant secret. These pin the reason
// to the rule that actually fired, so the alert can tell the owner which of the two happened.
describe('PayHere webhook rejection diagnosis', () => {
  it('says nothing when the body is in fact valid', () => {
    expect(adapter().describeWebhookRejection(signedNotify())).toBeNull();
  });

  it('names a bad signature as the one reason that implicates the secret', () => {
    const forged = signedNotify().replace(/md5sig=[A-F0-9]{32}/, `md5sig=${'A'.repeat(32)}`);
    expect(adapter().describeWebhookRejection(forged)?.reason).toBe('signature_mismatch');
  });

  it.each([
    ['payhere_amount', '8,700.00', 'amount_malformed'],
    ['status_code', '9', 'status_code_unknown'],
    ['payhere_currency', 'usd', 'currency_malformed'],
    ['merchant_id', '7654321', 'merchant_mismatch'],
    ['payment_id', '', 'payment_id_invalid'],
  ])('blames %s=%s on %s, not the signature', (field, value, reason) => {
    const r = adapter().describeWebhookRejection(signedNotify({ [field]: value }));
    expect(r?.reason).toBe(reason);
  });

  it('names the missing field so an empty probe does not read as a bad secret', () => {
    expect(adapter().describeWebhookRejection('')?.reason).toBe('missing_or_duplicate_field:merchant_id');
    const noSig = signedNotify().replace(/&md5sig=[A-F0-9]{32}/, '');
    expect(adapter().describeWebhookRejection(noSig)?.reason).toBe('missing_or_duplicate_field:md5sig');
  });

  it('reports the size refusal without pretending to have read the body', () => {
    const r = adapter().describeWebhookRejection(`${signedNotify()}&padding=${'x'.repeat(9_000)}`);
    expect(r?.reason).toBe('body_too_large');
    expect(r?.orderId).toBeUndefined();
  });

  // The single fact that makes a rejection actionable: WHICH booking to go reconcile by hand.
  it('carries the order id and status code off a body it refused', () => {
    const r = adapter().describeWebhookRejection(
      signedNotify({ order_id: 'CH-MCF8D', status_code: '9' }),
    );
    expect(r).toMatchObject({ orderId: 'CH-MCF8D', statusCode: '9', amount: '40.00', currency: 'USD' });
  });

  it('hashes the body instead of keeping it — a notify carries the payer name and card number', () => {
    const body = signedNotify({ status_code: '9' });
    const r = adapter().describeWebhookRejection(body);
    expect(r?.bodySha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('caps breadcrumbs, since a stranger chooses these strings and they land in an ops email', () => {
    const r = adapter().describeWebhookRejection(signedNotify({ order_id: 'C'.repeat(200) }));
    expect(r?.orderId).toHaveLength(64);
  });
});

// PayHere's Refund API. The cases below are ranked by what they cost when wrong: an outcome
// misread as 'failed' frees the money to be refunded a second time, so anything short of a
// definite answer must come back 'unknown'.
describe('PayHere Refund API', () => {
  const CREDS = { appId: 'app-1', appSecret: 'secret-1' };
  const TOKEN_OK = { access_token: 'tok-1', token_type: 'bearer', expires_in: 599, scope: 'SANDBOX' };

  function stub(responses: Array<{ status?: number; body?: unknown; throws?: Error; contentType?: string }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error('unexpected extra fetch');
      if (next.throws) throw next.throws;
      return {
        ok: (next.status ?? 200) < 400,
        status: next.status ?? 200,
        headers: new Headers(next.contentType ? { 'content-type': next.contentType } : {}),
        json: async () => {
          if (next.body === undefined) throw new SyntaxError('Unexpected end of JSON input');
          return next.body;
        },
      } as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const withApi = (impl: typeof fetch) =>
    new PayHerePaymentAdapter(MID, SECRET, {
      mode: 'sandbox', notifyUrl: 'https://example.com/w', returnUrl: 'https://s/r', cancelUrl: 'https://s/c',
    }, CREDS, impl);

  const args = {
    gatewayPaymentId: '320048263209', amountCents: 2900, currency: 'USD',
    description: 'Customer cancelled', isFullRefund: true,
  };

  it('has no refund route at all without API credentials', () => {
    const a = adapter();
    expect(a.canRefundViaApi).toBe(false);
    expect(withApi(stub([]).impl).canRefundViaApi).toBe(true);
  });

  it('authenticates, then refunds, and returns PayHere’s refund number', async () => {
    const { impl, calls } = stub([
      { body: TOKEN_OK },
      { body: { status: 1, msg: 'Successfully processed the refund', data: 560034010257 } },
    ]);
    const result = await withApi(impl).refund(args);
    expect(result).toMatchObject({ outcome: 'succeeded', gatewayRef: '560034010257' });
    expect(calls[0].url).toContain('/merchant/v1/oauth/token');
    expect(calls[0].init.body).toBe('grant_type=client_credentials');
    expect(String((calls[0].init.headers as Record<string, string>).authorization)).toBe(
      `Basic ${Buffer.from('app-1:secret-1').toString('base64')}`,
    );
    expect(calls[1].url).toContain('/merchant/v1/payment/refund');
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  // Their docs are explicit: omit `amount` for a full refund, send major units for a partial.
  it('omits the amount on a full refund and sends major units on a partial', async () => {
    const full = stub([{ body: TOKEN_OK }, { body: { status: 1, data: 1 } }]);
    await withApi(full.impl).refund(args);
    expect(JSON.parse(String(full.calls[1].init.body))).toEqual({
      payment_id: '320048263209', description: 'Customer cancelled',
    });
    const partial = stub([{ body: TOKEN_OK }, { body: { status: 1, data: 2 } }]);
    await withApi(partial.impl).refund({ ...args, amountCents: 1050, isFullRefund: false });
    expect(JSON.parse(String(partial.calls[1].init.body)).amount).toBe('10.50');
  });

  it('reuses a live token instead of authenticating per refund', async () => {
    const { impl, calls } = stub([
      { body: TOKEN_OK },
      { body: { status: 1, data: 1 } },
      { body: { status: 1, data: 2 } },
    ]);
    const a = withApi(impl);
    await a.refund(args);
    await a.refund(args);
    expect(calls.filter((call) => call.url.includes('oauth/token'))).toHaveLength(1);
  });

  it.each([
    [0, 'error initiating the refund'],
    [-1, 'Error processing refund'],
    [-2, 'Authentication error'],
  ])('treats status %i as a definite failure — the money did not move', async (status, msg) => {
    const { impl } = stub([{ body: TOKEN_OK }, { body: { status, msg, data: null } }]);
    const result = await withApi(impl).refund(args);
    expect(result.outcome).toBe('failed');
    expect(result.providerMessage).toBe(msg);
  });

  // ── everything below must NOT read as 'failed' ────────────────────────────────────────────

  it('calls a timeout unknown, never failed — the refund may already have happened', async () => {
    const { impl } = stub([{ body: TOKEN_OK }, { throws: new Error('The operation was aborted') }]);
    expect((await withApi(impl).refund(args)).outcome).toBe('unknown');
  });

  it('calls an unreadable body unknown', async () => {
    const { impl } = stub([{ body: TOKEN_OK }, { status: 502 }]);
    expect((await withApi(impl).refund(args)).outcome).toBe('unknown');
  });

  // payhere.lk is behind Cloudflare, which serves a "you have been blocked" HTML page to
  // clients it cannot identify (seen with plain curl, 2026-08-02). That page means the request
  // never reached the Refund API, so the money definitely did not move — stranding the row in
  // api_processing for a human would be wrong, and would block a re-request for no reason.
  it('treats a WAF HTML interstitial as failed — it never reached the API', async () => {
    const { impl } = stub([{ body: TOKEN_OK }, { status: 403, contentType: 'text/html; charset=UTF-8' }]);
    const result = await withApi(impl).refund(args);
    expect(result.outcome).toBe('failed');
    expect(result.providerMessage).toContain('blocked before reaching the API');
  });

  it('identifies itself, since an unnamed client is what the WAF blocks', async () => {
    const { impl, calls } = stub([{ body: TOKEN_OK }, { body: { status: 1, data: 1 } }]);
    await withApi(impl).refund(args);
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers['user-agent']).toContain('CeylonHop');
      expect(headers.accept).toBe('application/json');
    }
  });

  it('calls a response with no status field unknown rather than inventing one', async () => {
    const { impl } = stub([{ body: TOKEN_OK }, { body: { msg: 'who knows' } }]);
    expect((await withApi(impl).refund(args)).outcome).toBe('unknown');
  });

  // `data` is null on a successful AUTHORIZATION refund. We never issue those, so a null here
  // means we cannot identify what happened — and the ledger's evidence CHECK would reject it.
  it('calls success-with-no-reference unknown', async () => {
    const { impl } = stub([{ body: TOKEN_OK }, { body: { status: 1, msg: 'ok', data: null } }]);
    expect((await withApi(impl).refund(args)).outcome).toBe('unknown');
  });

  // Their docs name the field `status_code` in prose and `status` in every example.
  it('accepts status_code as a synonym for status', async () => {
    const { impl } = stub([{ body: TOKEN_OK }, { body: { status_code: 1, data: '99' } }]);
    expect(await withApi(impl).refund(args)).toMatchObject({ outcome: 'succeeded', gatewayRef: '99' });
  });

  // Token problems arrive in a DIFFERENT shape — {error, error_description}, no status. They are
  // safe to call failed: an unusable token means the refund was never asked for.
  it('treats an invalid-token body as failed, since nothing was ever requested', async () => {
    const { impl } = stub([
      { body: TOKEN_OK },
      { body: { error: 'invalid_token', error_description: 'Access token expired: tok-1' } },
    ]);
    const result = await withApi(impl).refund(args);
    expect(result.outcome).toBe('failed');
    expect(result.providerMessage).toContain('invalid_token');
  });

  it('treats a token endpoint failure as failed, not unknown', async () => {
    const { impl } = stub([{ status: 401, body: {} }]);
    expect((await withApi(impl).refund(args)).outcome).toBe('failed');
  });
});

// 2026-08-03: the first live attempt returned `token: payhere_token_http_403` and there was no
// way to tell whether Cloudflare had blocked our server at the edge (IP not whitelisted) or
// PayHere had rejected the key. Those have opposite fixes, so the status code alone is not a
// diagnosis. Cloudflare answers in HTML; PayHere answers in JSON.
describe('PayHere token failures name their cause', () => {
  const CREDS = { appId: 'app-1', appSecret: 'secret-1' };
  const args = {
    gatewayPaymentId: '320048263209', amountCents: 2900, currency: 'USD',
    description: 'x', isFullRefund: true,
  };
  const build = (status: number, contentType: string, text = '') =>
    new PayHerePaymentAdapter(MID, SECRET, {
      mode: 'sandbox', notifyUrl: 'https://e/w', returnUrl: 'https://s/r', cancelUrl: 'https://s/c',
    }, CREDS, (async () => ({
      ok: false,
      status,
      headers: new Headers({ 'content-type': contentType }),
      text: async () => text,
      json: async () => ({}),
    })) as unknown as typeof fetch);

  it('calls an HTML 403 a block at the edge, not a credential problem', async () => {
    const result = await build(403, 'text/html; charset=UTF-8', '<!DOCTYPE html>').refund(args);
    expect(result.outcome).toBe('failed');       // nothing was requested, so no money moved
    expect(result.providerMessage).toContain('blocked_at_edge');
    expect(result.providerMessage).toContain('not whitelisted');
  });

  it('calls a JSON 403 a rejection by PayHere, and passes their message through', async () => {
    const result = await build(403, 'application/json', '{"error":"invalid_client"}').refund(args);
    expect(result.providerMessage).toContain('rejected_by_payhere');
    expect(result.providerMessage).toContain('invalid_client');
  });
});

// Per-checkout return/cancel URLs (spec: docs/checkout-redirect-spec.md §D3). The adapter's
// constructor URLs are the WEBSITE checkout's pages; a pay-link customer must come back to the
// pay page instead. Absent args keep the constructor values, so the website flow is untouched.
describe('PayHerePaymentAdapter — per-checkout return/cancel URLs', () => {
  const base = { orderId: 'CH-ABC12', amount: 4000, currency: 'USD' } as const;

  it('falls back to the constructor URLs when the caller names none', async () => {
    const p = await adapter().createCheckout({ ...base });
    expect(p.fields?.return_url).toBe('https://site/return');
    expect(p.fields?.cancel_url).toBe('https://site/cancel');
  });

  it('uses the caller\'s URLs when given', async () => {
    const p = await adapter().createCheckout({
      ...base,
      returnUrl: 'https://pay.example.com/pay.html?rt=TOKEN',
      cancelUrl: 'https://pay.example.com/pay.html?rt=TOKEN&cancelled=1',
    });
    expect(p.fields?.return_url).toBe('https://pay.example.com/pay.html?rt=TOKEN');
    expect(p.fields?.cancel_url).toBe('https://pay.example.com/pay.html?rt=TOKEN&cancelled=1');
  });

  // The hash covers merchant_id + order_id + amount + currency ONLY. If overriding the URLs ever
  // changed it, every live payment would be refused at the gateway door.
  it('does not change the hash', async () => {
    const withUrls = await adapter().createCheckout({ ...base, returnUrl: 'https://a/x', cancelUrl: 'https://a/y' });
    const without = await adapter().createCheckout({ ...base });
    expect(withUrls.fields?.hash).toBe(without.fields?.hash);
  });
});
