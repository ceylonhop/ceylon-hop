import { test, expect } from '@playwright/test';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Owner-reported on a live payment (2026-08-02): a booking that settled while the ops tab was
// already open never appeared in the Bookings list. The row was healthy in the database —
// status 'paid', and the server's list applies no predicate that would hide it. The cause was
// purely client-side: loadQueue() ran ONCE at boot and entering the Bookings route never
// refetched, while the Quotes route always did. So the quote flipped to a green "Booked" chip
// (quotes refetch) beside a bookings list frozen from before the booking existed — which reads,
// on a real payment, as a lost booking.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const row = (reference) => ({
  id: 'b-' + reference, reference, channel: 'whatsapp', customerName: 'Test Customer',
  customerFirstName: 'Test', mode: 'single', route: 'Colombo → Kandy',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, amount: 3900, currency: 'USD',
  stage: 'paid', paymentStatus: 'paid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '',
});

test('entering Bookings refetches, so a booking that settles mid-session appears', async ({ page }) => {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });

  // The list starts empty and gains a booking after the first fetch — exactly the shape of a
  // payment settling while the operator sits on another tab.
  let bookingsFetches = 0;
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps: ['quote:manage', 'bookings:read'] })));
  await page.route('**/admin/ops/bookings', (r) => {
    bookingsFetches += 1;
    r.fulfill(json(bookingsFetches === 1 ? [] : [row('CH-RKWNW')]));
  });
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));

  await page.goto(OPS_FILE);
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });

  // Landed on Quotes; boot already pulled the (empty) bookings list in the background.
  await expect(page.locator('#view .qhead h1')).toHaveText('Quotes');
  await expect.poll(() => bookingsFetches, { timeout: 10000 }).toBe(1);

  await page.locator('#nav button[data-route="tickets"]').click();

  // The refetch is the fix. Without it this stays at 1 and the operator sees "No bookings yet".
  await expect.poll(() => bookingsFetches, { timeout: 10000 }).toBe(2);
  await expect(page.locator('#view')).toContainText('CH-RKWNW', { timeout: 10000 });
});

test('overlapping loads share one request rather than double-fetching', async ({ page }) => {
  // Boot fires loadQueue, and so does landing on Bookings via #bookings. Both callers must be
  // served by a single in-flight request.
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });

  let bookingsFetches = 0;
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps: ['bookings:read'] })));
  await page.route('**/admin/ops/bookings', async (r) => {
    bookingsFetches += 1;
    await new Promise((res) => setTimeout(res, 150)); // hold it open so any second caller overlaps
    r.fulfill(json([row('CH-0001')]));
  });
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));

  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
  await expect(page.locator('#view')).toContainText('CH-0001', { timeout: 10000 });
  expect(bookingsFetches).toBe(1);
});
