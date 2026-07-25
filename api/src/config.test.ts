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

  it('boots in production with real secrets', () => {
    expect(() =>
      buildConfig({
        NODE_ENV: 'production',
        OPS_SESSION_SECRET: 'a-real-32char-random-secret',
        BOOKING_LINK_SECRET: 'another-real-32char-secret',
        CUSTOMER_SESSION_SECRET: 'a-third-real-32char-secret',
        PAYHERE_MERCHANT_ID: '1226',
        PAYHERE_MERCHANT_SECRET: 'a-real-payhere-merchant-secret',
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
});
