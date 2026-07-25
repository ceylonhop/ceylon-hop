import { describe, it, expect, afterEach, vi } from 'vitest';

// Regression guard for the prod-boot crash: `app.ts` used to eagerly run
// `export const app = createApp()` at module load, which constructs a FakePaymentAdapter.
// After the payment-safety guard landed, that construction throws in production —
// so simply *importing* the app module crashed the boot before server.ts could wire
// the real PayHere adapter. Importing the module in production mode must not throw.
describe('production boot', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it('imports the app module in production mode without throwing (no eager fake-adapter construction)', async () => {
    // A production-like env with every fail-closed config guard satisfied, so the ONLY
    // thing that could throw is an eager payment-adapter construction at import time.
    process.env.NODE_ENV = 'production';
    process.env.OPS_SESSION_SECRET = 'test-ops-session-secret-not-the-default';
    process.env.BOOKING_LINK_SECRET = 'test-booking-link-secret-not-the-default';
    process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-not-default';
    process.env.PAYHERE_MERCHANT_ID = '1230050';
    process.env.PAYHERE_MERCHANT_SECRET = 'test-merchant-secret';
    delete process.env.ALLOW_FAKE_PAYMENTS; // prove it boots without the fake-payments escape hatch

    vi.resetModules();
    await expect(import('./app')).resolves.toBeDefined();
  });
});
