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

// A mobile double-tap lands two clicks before the first repaint, so the overlay that normally
// swallows the second click has not painted yet — dispatchEvent reproduces that by skipping
// hit-testing. Two runPayment() calls mean two draft bookings and two PayHere hand-offs for
// one trip; the submit latch must make the second click a no-op. (pay.html has carried this
// latch since #357 — this pins the same contract on the wizard, which takes the real money.)
test('a double-tap on Pay fires exactly one booking request', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  const posts = [];
  page.on('request', (r) => {
    if (r.url().includes('/bookings/single') && r.method() === 'POST') posts.push(r.url());
  });
  await page.locator('#pay-btn').dispatchEvent('click');
  await page.locator('#pay-btn').dispatchEvent('click');
  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
  expect(posts.length).toBe(1);
});

// The retry button re-enters runPayment with no scrim in the way at all; a second press while
// the retried attempt is still in flight must collapse into it. (After a terminal state a new
// press starting a new attempt is correct — only the in-flight window is latched, so the stub
// here answers slowly to hold that window open across both presses.)
test('double-pressing Try again while the retry is in flight fires exactly one booking request', async ({ page }) => {
  await gotoBooking(page, { bookingStatus: 500 });
  await fillContact(page);
  await page.click('#pay-btn');
  await expect(page.locator('#ph-retry')).toBeVisible();

  const posts = [];
  await page.route('**/bookings/single', async (r) => {
    posts.push(r.request().url());
    await new Promise((res) => setTimeout(res, 500));
    return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await page.locator('#ph-retry').dispatchEvent('click');
  await page.locator('#ph-retry').dispatchEvent('click');
  await expect(page.locator('#ph-retry')).toBeVisible({ timeout: 8000 });
  expect(posts.length).toBe(1);
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

test('checkout sends the scoped capability returned by booking creation', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  const checkoutRequest = page.waitForRequest('**/bookings/*/checkout');
  await page.click('#pay-btn');
  expect((await checkoutRequest).headers().authorization).toBe('Bearer e2e-checkout-token');
  expect(await page.evaluate(() => JSON.stringify(window.dataLayer))).not.toContain(
    'e2e-checkout-token',
  );
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

test('a multi-stop tour also mints a locked quote and books against it (rate-lock §5)', async ({ page }) => {
  await gotoBooking(page, { query: 'mode=trip&stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla&nights=0,1,0&dates=2026-08-08,2026-08-10&pax=2&vehicle=car' });
  await fillContact(page);
  const lockP = page.waitForRequest('**/quote/lock');
  const bookP = page.waitForRequest('**/bookings/trip');
  await page.click('#pay-btn');
  await lockP;
  const body = JSON.parse((await bookP).postData() || '{}');
  expect(body.quoteId).toBe('ql-e2e-1'); // the tour booking carries the locked quote id
});
