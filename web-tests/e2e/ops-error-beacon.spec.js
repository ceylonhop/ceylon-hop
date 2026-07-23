import { test, expect } from '@playwright/test';

// Handled-failure beacons (follow-up to the 2026-07-22 wrong-quote race): the ops UI's
// catch blocks swallow errors into a toast or a silent fallback — right for the operator,
// invisible to Sentry. window.opsReportError (head beacon IIFE) now forwards those to
// /errors/client with a context tag. This pins the two ends of that wiring:
//   1. a failing quote-list load beacons with the 'loadOpsQuotes' context (and still toasts);
//   2. a stale quote-open response that the _openSeq guard discards beacons a counter event,
//      so we learn how often the race actually fires in prod.
// sendBeacon is disabled so the snippet takes its fetch fallback, which Playwright can
// intercept deterministically (same technique as error-beacon.spec.js). Fully stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const armBeacon = async (page) => {
  const hits = [];
  await page.addInitScript(() => { delete navigator.__proto__.sendBeacon; navigator.sendBeacon = undefined; });
  await page.route('**/errors/client', async (route) => {
    hits.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 204, body: '' });
  });
  return hits;
};

const armShell = async (page) => {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async () => ({}) } };
  });
  // Catch-all FIRST; specific routes after (Playwright: last-registered wins).
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve'] })));
};

test('a failing quote-list load beacons to /errors/client with its context tag', async ({ page }) => {
  const hits = await armBeacon(page);
  await armShell(page);
  await page.route('**/admin/quote/list**', (r) => r.fulfill({ status: 500, body: 'boom' }));

  await page.goto(OPS_FILE + '#quotes');

  // Operator experience unchanged: the failure still surfaces as the toast.
  await expect(page.locator('#toast')).toContainText('Could not load quotes', { timeout: 10000 });
  // …and now it also reaches the error sink, tagged with the swallow site.
  await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  const hit = hits.find((h) => (h.message || '').includes('loadOpsQuotes'));
  expect(hit, 'beacon tagged loadOpsQuotes').toBeTruthy();
  expect(hit.message).toContain('[ops-ui]');
});

test('a discarded stale quote-open response beacons a counter event', async ({ page }) => {
  const hits = await armBeacon(page);
  await armShell(page);

  const detail = (id, firstName) => ({
    id, reference: 'Q-' + id.toUpperCase(), channel: 'ops', status: 'ready',
    product: 'private', vehicle: 'car', customerName: firstName + ' T',
    totalCents: 12100, currency: 'USD',
    request: { tool: {
      name: firstName + ' T', firstName, lastName: 'T', contact: '+94 77 123 4567',
      vehicle: 'car', service: 'private', requestedService: 'private',
      passengerCount: 2, luggageCount: 2,
      legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
    } },
    result: { totalCents: 12100 },
    estimate: { product: 'private', total: { cents: 12100, lkr: 'LKR 39,930' },
      lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 12100 }], warnings: [] },
  });
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [
    { id: 'slow1', reference: 'Q-SLOW1', customerName: 'Alpha T', product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD', status: 'ready' },
    { id: 'fast1', reference: 'Q-FAST1', customerName: 'Beta T', product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD', status: 'ready' },
  ] })));
  let releaseSlow;
  const slowHeld = new Promise((res) => { releaseSlow = res; });
  await page.route(/\/admin\/quote\/slow1$/, async (r) => { await slowHeld; await r.fulfill(json(detail('slow1', 'Alpha'))); });
  await page.route(/\/admin\/quote\/fast1$/, (r) => r.fulfill(json(detail('fast1', 'Beta'))));

  await page.goto(OPS_FILE + '#quotes');
  await page.locator('.qrow[data-qopen="slow1"]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.goBack();
  await page.locator('.qrow[data-qopen="fast1"]').click();
  await expect(page.locator('#f-firstName')).toHaveValue('Beta', { timeout: 10000 });

  releaseSlow();

  await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  const hit = hits.find((h) => (h.message || '').includes('stale open discarded'));
  expect(hit, 'beacon for the discarded stale open').toBeTruthy();
  expect(hit.message).toContain('reopenQuote');
  // The guard still holds: the builder shows the quote clicked last.
  await expect(page.locator('#f-firstName')).toHaveValue('Beta');
});
