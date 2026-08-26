import { describe, it, expect } from 'vitest';
import { buildConfig } from './config';

// The founder ops-session cookie now unlocks /admin/quote (margin + customer PII), so a
// defaulted/empty OPS_SESSION_SECRET in production is a founder-forgery hole: anyone who
// reads the public repo can mint a valid founder cookie. Production must FAIL CLOSED at
// boot; dev/test keep the convenience default.
describe('config — OPS_SESSION_SECRET fails closed in production', () => {
  it('throws in production when OPS_SESSION_SECRET is unset (falls back to the dev default)', () => {
    expect(() => buildConfig({ NODE_ENV: 'production' })).toThrow(/OPS_SESSION_SECRET/);
  });

  it('throws in production when OPS_SESSION_SECRET is explicitly the dev default', () => {
    expect(() =>
      buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: 'dev-ops-secret-change-me' }),
    ).toThrow(/OPS_SESSION_SECRET/);
  });

  it('throws in production when OPS_SESSION_SECRET is empty', () => {
    expect(() => buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: '' })).toThrow(
      /OPS_SESSION_SECRET/,
    );
  });

  it('throws in production when BOOKING_LINK_SECRET is the dev default (or unset)', () => {
    expect(() =>
      buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: 'a-real-32char-random-secret', BOOKING_LINK_SECRET: 'dev-booking-link-secret-change-me' }),
    ).toThrow(/BOOKING_LINK_SECRET/);
    // unset → falls back to the dev default → also throws
    expect(() =>
      buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: 'a-real-32char-random-secret' }),
    ).toThrow(/BOOKING_LINK_SECRET/);
  });

  it('the customer-session secret also fails closed in production', () => {
    // real ops + booking secrets, but the customer secret left at its dev default → throws
    expect(() =>
      buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: 'a-real-32char-random-secret', BOOKING_LINK_SECRET: 'another-real-32char-secret' }),
    ).toThrow(/CUSTOMER_SESSION_SECRET/);
  });

  it('the PayHere credentials also fail closed in production', () => {
    // Without them the payment seam falls back to FakePaymentAdapter, whose signing key is a
    // constant in this repo — anyone could forge a "succeeded" webhook and pay nothing.
    const base = {
      NODE_ENV: 'production',
      OPS_SESSION_SECRET: 'a-real-32char-random-secret',
      BOOKING_LINK_SECRET: 'another-real-32char-secret',
      CUSTOMER_SESSION_SECRET: 'a-third-real-32char-secret',
    };
    expect(() => buildConfig(base)).toThrow(/PAYHERE_MERCHANT_ID and PAYHERE_MERCHANT_SECRET/);
    // one without the other is still a fallback to the fake adapter
    expect(() => buildConfig({ ...base, PAYHERE_MERCHANT_ID: '1226' })).toThrow(/PAYHERE_/);
    expect(() => buildConfig({ ...base, PAYHERE_MERCHANT_SECRET: 'live-secret' })).toThrow(/PAYHERE_/);
    // empty strings are the same failure mode as unset
    expect(() =>
      buildConfig({ ...base, PAYHERE_MERCHANT_ID: '', PAYHERE_MERCHANT_SECRET: '' }),
    ).toThrow(/PAYHERE_/);
  });

  it('the main checkout notify URL fails closed in production', () => {
    // PayHere reports a completed payment by POSTing to notify_url. Sent empty, the gateway has
    // nowhere to report to: the customer's money is captured and the booking never leaves
    // payment_pending, with no confirmation email. The ride board already fails closed on its
    // own notify URL — the checkout that takes every public booking must too.
    const base = {
      NODE_ENV: 'production',
      OPS_SESSION_SECRET: 'a-real-32char-random-secret',
      BOOKING_LINK_SECRET: 'another-real-32char-secret',
      CUSTOMER_SESSION_SECRET: 'a-third-real-32char-secret',
      PAYHERE_MERCHANT_ID: '1226',
      PAYHERE_MERCHANT_SECRET: 'a-real-payhere-merchant-secret',
      PAYHERE_APP_ID: 'app-id',
      PAYHERE_APP_SECRET: 'app-secret',
      PAYHERE_RIDE_NOTIFY_URL: 'https://ops.ceylonhop.com/board/payhere/notify',
    };
    expect(() => buildConfig(base)).toThrow(/PAYHERE_NOTIFY_URL/);
    // an empty string is the same failure mode as unset — that is exactly what reaches
    // the checkout form as notify_url=""
    expect(() => buildConfig({ ...base, PAYHERE_NOTIFY_URL: '' })).toThrow(/PAYHERE_NOTIFY_URL/);
    expect(() =>
      buildConfig({ ...base, PAYHERE_NOTIFY_URL: 'https://ceylon-hop-api.onrender.com/webhooks/payments' }),
    ).not.toThrow();
    // a deployment on fake payments has no gateway to report anything, so the guard lifts
    expect(() => buildConfig({ ...base, ALLOW_FAKE_PAYMENTS: '1' })).not.toThrow();
  });

  // Staging on Render runs NODE_ENV=production but deliberately uses the fake payment adapter,
  // so it needs an explicit way out. It must stay explicit: anything falsy leaves the guard armed.
  it('lets a deployment opt out of the PayHere requirement, but only deliberately', () => {
    const base = {
      NODE_ENV: 'production',
      OPS_SESSION_SECRET: 'a-real-32char-random-secret',
      BOOKING_LINK_SECRET: 'another-real-32char-secret',
      CUSTOMER_SESSION_SECRET: 'a-third-real-32char-secret',
    };
    expect(() => buildConfig({ ...base, ALLOW_FAKE_PAYMENTS: '1' })).not.toThrow();
    expect(() => buildConfig({ ...base, ALLOW_FAKE_PAYMENTS: 'true' })).not.toThrow();
    // Anything that isn't a deliberate opt-in keeps real production failing closed.
    for (const v of ['', '0', 'false', 'no', 'maybe', undefined]) {
      expect(() => buildConfig({ ...base, ALLOW_FAKE_PAYMENTS: v })).toThrow(/PAYHERE_/);
    }
  });

  it('boots in production with real secrets', () => {
    expect(() =>
      buildConfig({
        NODE_ENV: 'production',
        OPS_SESSION_SECRET: 'a-real-32char-random-secret',
        BOOKING_LINK_SECRET: 'another-real-32char-secret',
        CUSTOMER_SESSION_SECRET: 'a-third-real-32char-secret',
        PAYHERE_MERCHANT_ID: '1226',
        PAYHERE_MERCHANT_SECRET: 'a-real-payhere-merchant-secret',
        PAYHERE_NOTIFY_URL: 'https://ceylon-hop-api.onrender.com/webhooks/payments',
        PAYHERE_APP_ID: 'app-id',
        PAYHERE_APP_SECRET: 'app-secret',
        PAYHERE_RIDE_NOTIFY_URL: 'https://ops.ceylonhop.com/board/payhere/notify',
      }),
    ).not.toThrow();
  });

  it('does not require PayHere credentials outside production', () => {
    expect(() => buildConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => buildConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('tolerates the default secret outside production (dev/test)', () => {
    expect(buildConfig({ NODE_ENV: 'test' }).OPS_SESSION_SECRET).toBe('dev-ops-secret-change-me');
    expect(buildConfig({ NODE_ENV: 'development' }).OPS_SESSION_SECRET).toBe('dev-ops-secret-change-me');
  });

  it('keeps public quote v2 creation default-off unless explicitly enabled', () => {
    expect(buildConfig({ NODE_ENV: 'test' }).QUOTE_V2_ENABLED).toBe(false);
    expect(buildConfig({ NODE_ENV: 'test', QUOTE_V2_ENABLED: '1' }).QUOTE_V2_ENABLED).toBe(true);
  });

  it('keeps customer short links default-off and refuses an ambiguous value', () => {
    expect(buildConfig({ NODE_ENV: 'test' }).CUSTOMER_SHORT_LINKS_ENABLED).toBe(false);
    expect(buildConfig({ NODE_ENV: 'test', CUSTOMER_SHORT_LINKS_ENABLED: 'false' })
      .CUSTOMER_SHORT_LINKS_ENABLED).toBe(false);
    expect(buildConfig({ NODE_ENV: 'test', CUSTOMER_SHORT_LINKS_ENABLED: '0' })
      .CUSTOMER_SHORT_LINKS_ENABLED).toBe(false);
    expect(buildConfig({ NODE_ENV: 'test', CUSTOMER_SHORT_LINKS_ENABLED: '1' })
      .CUSTOMER_SHORT_LINKS_ENABLED).toBe(true);
    expect(buildConfig({ NODE_ENV: 'test', CUSTOMER_SHORT_LINKS_ENABLED: 'true' })
      .CUSTOMER_SHORT_LINKS_ENABLED).toBe(true);
    // Spec 7.5: production must not activate because some arbitrary string was truthy.
    expect(() => buildConfig({ NODE_ENV: 'test', CUSTOMER_SHORT_LINKS_ENABLED: 'yes' })).toThrow();
  });

  it('keeps legacy tokenless checkout default-off and refuses it in live production', () => {
    expect(buildConfig({ NODE_ENV: 'test' }).CHECKOUT_TOKEN_COMPATIBILITY).toBe(false);
    expect(
      buildConfig({ NODE_ENV: 'test', CHECKOUT_TOKEN_COMPATIBILITY: 'true' })
        .CHECKOUT_TOKEN_COMPATIBILITY,
    ).toBe(true);
    expect(() =>
      buildConfig({
        NODE_ENV: 'production',
        OPS_SESSION_SECRET: 'a-real-32char-random-secret',
        BOOKING_LINK_SECRET: 'another-real-32char-secret',
        CUSTOMER_SESSION_SECRET: 'a-third-real-32char-secret',
        PAYHERE_MERCHANT_ID: '1226',
        PAYHERE_MERCHANT_SECRET: 'a-real-payhere-merchant-secret',
        PAYHERE_APP_ID: 'app-id',
        PAYHERE_APP_SECRET: 'app-secret',
        PAYHERE_RIDE_NOTIFY_URL: 'https://ops.ceylonhop.com/board/payhere/notify',
        CHECKOUT_TOKEN_COMPATIBILITY: 'true',
      }),
    ).toThrow(/CHECKOUT_TOKEN_COMPATIBILITY/);
    expect(() =>
      buildConfig({
        NODE_ENV: 'production',
        OPS_SESSION_SECRET: 'a-real-32char-random-secret',
        BOOKING_LINK_SECRET: 'another-real-32char-secret',
        CUSTOMER_SESSION_SECRET: 'a-third-real-32char-secret',
        ALLOW_FAKE_PAYMENTS: 'true',
        CHECKOUT_TOKEN_COMPATIBILITY: 'true',
      }),
    ).not.toThrow();
  });
});
