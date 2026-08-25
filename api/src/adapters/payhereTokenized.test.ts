import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PayHereTokenizedPaymentAdapter } from './payhereTokenized';

const MID = '1234567';
const SECRET = 'merchant-secret';
const md5 = (value: string) => createHash('md5').update(value).digest('hex').toUpperCase();

const customer = {
  firstName: 'Roshen',
  lastName: 'Wijesinghe',
  email: 'roshen@example.com',
  phone: '+94771234567',
  address: '12 Galle Road',
  city: 'Colombo',
  country: 'Sri Lanka',
};

function adapter(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  return new PayHereTokenizedPaymentAdapter(
    MID,
    SECRET,
    {
      mode: 'sandbox',
      notifyUrl: 'https://ops.ceylonhop.com/board/payhere/notify',
    },
    { appId: 'app-id', appSecret: 'app-secret' },
    fetchImpl,
  );
}

function liveAdapter(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch) {
  return new PayHereTokenizedPaymentAdapter(
    MID,
    SECRET,
    {
      mode: 'live',
      notifyUrl: 'https://ops.ceylonhop.com/board/payhere/notify',
    },
    { appId: 'app-id', appSecret: 'app-secret' },
    fetchImpl,
  );
}

describe('PayHereTokenizedPaymentAdapter — preapproval', () => {
  it('creates a hosted PayHere preapproval without charging the ride fare', async () => {
    const result = await adapter().preapprove({
      customerRef: 'google-sub',
      orderId: 'RBPA-123',
      items: 'Ceylon Hop Ride Board card approval',
      currency: 'USD',
      returnUrl: 'https://ceylonhop.com/board.html?ridePayment=RBPA-123',
      cancelUrl: 'https://ceylonhop.com/board.html?ridePayment=RBPA-123&cancelled=1',
      customer,
    });

    expect(result.status).toBe('requires_action');
    if (result.status !== 'requires_action') throw new Error('expected hosted checkout');
    expect(result.checkout.checkoutUrl).toBe('https://sandbox.payhere.lk/pay/preapprove');
    expect(result.checkout.fields).toMatchObject({
      merchant_id: MID,
      order_id: 'RBPA-123',
      currency: 'USD',
      first_name: 'Roshen',
      last_name: 'Wijesinghe',
      phone: '+94771234567',
      address: '12 Galle Road',
      city: 'Colombo',
      country: 'Sri Lanka',
    });
    expect(result.checkout.fields.amount).toBeUndefined();
    expect(result.checkout.fields.hash).toBe(
      md5(`${MID}RBPA-1231.01USD${md5(SECRET)}`),
    );
  });

  // PROD: every live preapproval died at `PH-0014 Unauthorized payment request`.
  // PayHere support, 2026-08-24: "Please use 0.51 as the authorization amount for other
  // currencies when generating the hash value... the authorization amount has been changed
  // in the PayHere Live environment. This change will be reflected in the PayHere
  // documentation soon." Their published docs still say 1.01, and sandbox still expects it —
  // so this is deliberately a LIVE-only value, and the sandbox test above still pins 1.01.
  it('hashes a non-LKR live preapproval over 0.51, not the documented 1.01', async () => {
    const result = await liveAdapter().preapprove({
      customerRef: 'google-sub',
      orderId: 'RBPA-123',
      items: 'Ceylon Hop shared ride Kandy to Ella',
      currency: 'USD',
      returnUrl: 'https://prod.ceylonhop.com/board.html?ridePayment=RBPA-123',
      cancelUrl: 'https://prod.ceylonhop.com/board.html?ridePayment=RBPA-123&cancelled=1',
      customer,
    });
    if (result.status !== 'requires_action') throw new Error('expected hosted checkout');
    expect(result.checkout.checkoutUrl).toBe('https://www.payhere.lk/pay/preapprove');
    expect(result.checkout.fields.amount).toBeUndefined();
    expect(result.checkout.fields.hash).toBe(
      md5(`${MID}RBPA-1230.51USD${md5(SECRET)}`),
    );
  });

  it('still hashes a live LKR preapproval over 10.00 — the change was other currencies only', async () => {
    const result = await liveAdapter().preapprove({
      customerRef: 'google-sub',
      orderId: 'RBPA-124',
      currency: 'LKR',
      returnUrl: 'https://prod.ceylonhop.com/board.html',
      cancelUrl: 'https://prod.ceylonhop.com/board.html?cancelled=1',
      customer,
    });
    if (result.status !== 'requires_action') throw new Error('expected hosted checkout');
    expect(result.checkout.fields.hash).toBe(
      md5(`${MID}RBPA-12410.00LKR${md5(SECRET)}`),
    );
  });

  it('refuses to fabricate PayHere-required customer details', async () => {
    await expect(adapter().preapprove({
      customerRef: 'google-sub',
      orderId: 'RBPA-123',
      items: 'Ride Board',
      currency: 'USD',
      returnUrl: 'https://ceylonhop.com/board.html',
      cancelUrl: 'https://ceylonhop.com/board.html',
      customer: { ...customer, phone: '' },
    })).rejects.toThrow('payment_details_required');
  });
});

describe('PayHereTokenizedPaymentAdapter — signed preapproval notification', () => {
  it('accepts a genuine success and returns the encrypted customer token', () => {
    const payhere = adapter();
    const raw = payhere.simulatePreapprovalNotify({
      orderId: 'RBPA-123',
      customerToken: 'encrypted-customer-token',
    });
    expect(payhere.parsePreapprovalWebhook(raw)).toMatchObject({
      orderId: 'RBPA-123',
      status: 'succeeded',
      ref: 'encrypted-customer-token',
      providerTxnId: 'PAY-PREAPPROVAL-1',
    });
  });

  it('rejects a forged signature and a success without a customer token', () => {
    const payhere = adapter();
    const genuine = payhere.simulatePreapprovalNotify({ orderId: 'RBPA-123', customerToken: 'token' });
    expect(payhere.parsePreapprovalWebhook(
      genuine.replace(/md5sig=[^&]+/, 'md5sig=00000000000000000000000000000000'),
    )).toBeNull();
    expect(payhere.parsePreapprovalWebhook(
      payhere.simulatePreapprovalNotify({ orderId: 'RBPA-123', customerToken: '' }),
    )).toBeNull();
  });
});

describe('PayHereTokenizedPaymentAdapter — Automated Charging API', () => {
  it('gets an OAuth token and charges the approved card in minor-unit exact USD', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'oauth-token', expires_in: 599 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 1,
        msg: 'Automatic payment charged successfully',
        data: { payment_id: 320025021815, status_code: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await adapter(fetchImpl as unknown as typeof fetch).charge({
      ref: 'encrypted-customer-token',
      amountCents: 2950,
      currency: 'USD',
      orderId: 'EM-4821-google-sub',
    });

    expect(result).toEqual({ status: 'succeeded', providerTxnId: '320025021815' });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://sandbox.payhere.lk/merchant/v1/oauth/token',
      expect.objectContaining({ method: 'POST', body: 'grant_type=client_credentials' }),
    );
    const charge = fetchImpl.mock.calls[1];
    expect(charge[0]).toBe('https://sandbox.payhere.lk/merchant/v1/payment/charge');
    expect(JSON.parse(charge[1].body)).toMatchObject({
      type: 'PAYMENT',
      order_id: 'EM-4821-google-sub',
      currency: 'USD',
      amount: 29.5,
      customer_token: 'encrypted-customer-token',
    });
  });

  it('fails closed before contacting PayHere for an invalid token or amount', async () => {
    const fetchImpl = vi.fn();
    const payhere = adapter(fetchImpl as unknown as typeof fetch);
    await expect(payhere.charge({ ref: '', amountCents: 2950, currency: 'USD', orderId: 'order' }))
      .resolves.toMatchObject({ status: 'failed', failureReason: 'invalid_charge_request' });
    await expect(payhere.charge({ ref: 'token', amountCents: 0, currency: 'USD', orderId: 'order' }))
      .resolves.toMatchObject({ status: 'failed', failureReason: 'invalid_charge_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
