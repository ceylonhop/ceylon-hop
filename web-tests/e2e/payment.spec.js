import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

test('clicking Pay opens the payment overlay immediately', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  await page.click('#pay-btn');
  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect(page.locator('#ph-spin')).toBeVisible();
});

test('a booking-API failure shows an error state inside the overlay (not a stray note)', async ({ page }) => {
  await gotoBooking(page, { bookingStatus: 500 });
  await fillContact(page);
  await page.click('#pay-btn');

  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect(page.locator('#ph-ico')).toBeVisible();
  await expect(page.locator('#ph-actions')).toBeVisible();
  await expect(page.locator('#ph-retry')).toBeVisible();
  await expect(page.locator('#ph-msg')).toContainText('couldn’t start your booking');
  // the inline form error must NOT be used for payment outcomes
  await expect(page.locator('#details-error')).toBeHidden();
});

test('cancelling PayHere shows the cancelled state with a retry option', async ({ page }) => {
  await gotoBooking(page, { checkout: 'payhere', payhere: 'dismissed' });
  await fillContact(page);
  await page.click('#pay-btn');

  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect(page.locator('#ph-msg')).toContainText('cancelled');
  await expect(page.locator('#ph-retry')).toBeVisible();

  // Close dismisses the overlay
  await page.click('#ph-close');
  await expect(page.locator('#ph-overlay')).toBeHidden();
});

test('demo mode (api=off) completes to a confirmation reference', async ({ page }) => {
  await gotoBooking(page, { query: 'mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car&api=off' });
  await fillContact(page);
  await page.click('#pay-btn');
  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
});

// The wizard's on-page estimate comes from the URL price / browser-measured distance; the API
// reprices from its own server-side distance and that is what PayHere actually charges. The
// confirmation must reflect the SERVER amount, so the customer is never billed a figure they
// weren't shown at the moment of payment. Here the URL says $121 but the API returns $115.
test('confirmation shows the server-authoritative amount, not the wizard estimate (fake gateway)', async ({ page }) => {
  await gotoBooking(page, { bookingTotal: 11500 });
  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
  await expect(page.locator('#pass-paid')).toHaveText('$115');
});

test('server-authoritative amount also flows through the real PayHere path', async ({ page }) => {
  await gotoBooking(page, { checkout: 'payhere', payhere: 'completed', bookingTotal: 11500 });
  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
  await expect(page.locator('#pass-paid')).toHaveText('$115');
});

test('booking creation sends a stable Idempotency-Key so a retried POST dedupes', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  const reqP = page.waitForRequest('**/bookings/single');
  await page.click('#pay-btn');
  const req = await reqP;
  const key = req.headers()['idempotency-key'];
  expect(key).toBeTruthy();
  expect(key).toMatch(/^ch-/);
});

test('a single transfer mints a 7-day locked quote and books against it (rate-lock §5)', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  const lockP = page.waitForRequest('**/quote/lock');
  const bookP = page.waitForRequest('**/bookings/single');
  await page.click('#pay-btn');
  await lockP; // the client minted a lock BEFORE booking
  const body = JSON.parse((await bookP).postData() || '{}');
  expect(body.quoteId).toBe('ql-e2e-1'); // the booking carries the locked quote id
  // …and it's cached (with its expiry) so a return visit within the window reuses the same lock.
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('chQuoteLock') || 'null'));
  expect(cached.quoteId).toBe('ql-e2e-1');
  expect(cached.exp).toBeGreaterThan(Date.now());
});
