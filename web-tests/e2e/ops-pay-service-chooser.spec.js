import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';

// Pay link for either option of a "both" quote (spec 2026-10-12 §4.4). Pressing Payment link on a
// ready/sent quote that carries a stored chauffeur alternative asks which option the link is for;
// a quote without one behaves exactly as before. Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const BOTH_OPTIONS = {
  primary: { service: 'private', totalCents: 14900 },
  alternative: { service: 'chauffeur', totalCents: 22300, depositCents: 5000 },
  linkedService: null,
};

function fullQuote(over = {}) {
  return {
    id: 'q1', reference: 'Q-Q1', channel: 'ops', status: 'ready', product: 'private', vehicle: 'car',
    customerName: 'Maya', customerContact: '+44 7700 900000', totalCents: 14900, currency: 'USD',
    notes: null, createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T10:00:00.000Z',
    request: {
      tool: {
        name: 'Maya', contact: '+44 7700 900000', vehicle: 'car', service: 'private',
        requestedService: 'both', passengerCount: 2, luggageCount: 2,
        legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
      },
    },
    result: { totalCents: 14900 },
    customerTotalVia: null,
    estimate: {
      product: 'private',
      total: { cents: 14900, lkr: 'LKR 49,170' },
      lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 14900 }],
      warnings: [],
    },
    payOptions: BOTH_OPTIONS,
    ...over,
  };
}

async function openReadyQuote(page, quote, { urls = {} } = {}) {
  const posts = [];
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
    // The clipboard is the observable: record what was written instead of needing a permission.
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true });
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await routeOpsEstimate(page);
  await page.route('**/admin/quote/q1', (r) => r.fulfill(json(quote)));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [{
    id: 'q1', reference: 'Q-Q1', customerName: 'Maya', product: 'private', vehicle: 'car', totalCents: 14900, currency: 'USD', status: quote.status,
  }] })));
  await page.route('**/admin/quote/q1/pay-link', (r) => {
    const data = r.request().postData();
    posts.push(data);
    const service = data ? JSON.parse(data).service : undefined;
    const amountCents = service === 'chauffeur' ? 22300 : 14900;
    r.fulfill(json({
      url: urls[service || 'private'] || ('https://pay.example.test/' + (service || 'private')),
      payhereMode: 'live', amountCents, coverage: null, ...(service ? { service } : {}),
    }));
  });
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'founder@e2e.test', role: 'founder',
    caps: ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'bookings:operate', 'payments:act'],
  })));
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('#view .qrow').first().click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.waitForSelector('.ch-status-pill', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
  return { posts };
}
const payBtn = (page) => page.locator('.ch-actionbar [data-action="mintPayLink"]');
const chooser = (page) => page.locator('#pay-chooser');
const copied = (page) => page.evaluate(() => window.__copied);

test('a "both" quote: Payment link asks which option, and the pick mints that service only', async ({ page }) => {
  const { posts } = await openReadyQuote(page, fullQuote());
  await payBtn(page).click();

  await expect(chooser(page)).toBeVisible();
  // Nothing minted yet, nothing copied: the press only asked the question.
  expect(posts).toHaveLength(0);
  const point = chooser(page).locator('[data-action="payChoose"][data-service="private"]');
  const chauffeur = chooser(page).locator('[data-action="payChoose"][data-service="chauffeur"]');
  await expect(point).toContainText('Point-to-point');
  await expect(point).toContainText('$149.00');
  await expect(chauffeur).toContainText('Chauffeur-guide');
  await expect(chauffeur).toContainText('$223.00');
  // The deposit rides on the chauffeur option only.
  await expect(chooser(page)).toContainText('customer can pay a $50.00 deposit');
  await expect(point).not.toContainText('deposit');

  await chauffeur.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toBe('{"service":"chauffeur"}');
  await expect(chooser(page)).toHaveCount(0);
  await expect.poll(() => copied(page)).toEqual(['https://pay.example.test/chauffeur']);
  await expect(page.locator('#ch-toast .ch-toast-msg')).toHaveText('Chauffeur-guide payment link copied');
  // …and the page says which link is out.
  await expect(page.locator('#pay-linkout')).toContainText('Chauffeur-guide link is out — sending the other option replaces it');
});

test('picking the same option again copies from cache; the other option mints', async ({ page }) => {
  const { posts } = await openReadyQuote(page, fullQuote());
  const pick = async (service) => {
    // The button goes inert for a moment after a copy ("Link copied"), so wait for it to return.
    await expect(payBtn(page)).toBeEnabled({ timeout: 8000 });
    await payBtn(page).click();
    await chooser(page).locator(`[data-action="payChoose"][data-service="${service}"]`).click();
  };
  await pick('chauffeur');
  await expect.poll(() => copied(page)).toHaveLength(1);
  await pick('chauffeur');
  await expect.poll(() => copied(page)).toHaveLength(2);
  expect(posts).toHaveLength(1); // the second copy made no request
  expect(await copied(page)).toEqual(['https://pay.example.test/chauffeur', 'https://pay.example.test/chauffeur']);

  await pick('private');
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toBe('{"service":"private"}');
  await expect.poll(() => copied(page)).toHaveLength(3);
  expect((await copied(page))[2]).toBe('https://pay.example.test/private');
  await expect(page.locator('#pay-linkout')).toContainText('Point-to-point link is out');
});

test('Cancel closes the chooser without minting or copying', async ({ page }) => {
  const { posts } = await openReadyQuote(page, fullQuote());
  await payBtn(page).click();
  await chooser(page).locator('[data-action="cancelPayChoose"]').click();
  await expect(chooser(page)).toHaveCount(0);
  expect(posts).toHaveLength(0);
  expect(await copied(page)).toEqual([]);
});

test('a link already out for the chauffeur option (from the server) is named before any press', async ({ page }) => {
  await openReadyQuote(page, fullQuote({ payOptions: { ...BOTH_OPTIONS, linkedService: 'chauffeur' }, customerTotalVia: 'pay_link' }));
  await expect(page.locator('#pay-linkout')).toContainText('Chauffeur-guide link is out');
});

test('D5: a payment already started on the current link is warned about, never blocked', async ({ page }) => {
  const { posts } = await openReadyQuote(page, fullQuote({
    payOptions: { ...BOTH_OPTIONS, linkedService: 'chauffeur' }, customerTotalVia: 'pay_link', convertedBookingId: 'b1',
  }));
  await payBtn(page).click();
  await expect(chooser(page)).toBeVisible();
  await expect(chooser(page)).toContainText('A payment was started on the current link — it is not cancelled by switching.');
  // Warn only: switching still works.
  await chooser(page).locator('[data-action="payChoose"][data-service="private"]').click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toBe('{"service":"private"}');
});

test('no warning when no payment was started', async ({ page }) => {
  await openReadyQuote(page, fullQuote({ payOptions: { ...BOTH_OPTIONS, linkedService: 'chauffeur' }, customerTotalVia: 'pay_link' }));
  await payBtn(page).click();
  await expect(chooser(page)).toBeVisible();
  await expect(chooser(page)).not.toContainText('A payment was started');
});

test('a single-service quote has no chooser: one press mints a bodyless link and copies it', async ({ page }) => {
  const { posts } = await openReadyQuote(page, fullQuote({ payOptions: null }));
  await payBtn(page).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toBeNull(); // no body at all — today's request
  await expect.poll(() => copied(page)).toEqual(['https://pay.example.test/private']);
  await expect(chooser(page)).toHaveCount(0);
  await expect(page.locator('#pay-linkout')).toHaveCount(0);
});

test('"Part of trip…" stays: it is still offered on a "both" quote', async ({ page }) => {
  await openReadyQuote(page, fullQuote());
  await expect(page.locator('.ch-actionbar [data-action="openPayPart"]')).toBeVisible();
});
