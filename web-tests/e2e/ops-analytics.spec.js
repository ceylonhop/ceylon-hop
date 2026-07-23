import { test, expect } from '@playwright/test';

// Founder analytics (spec 2026-07-23): the Analytics surface is analytics:view-gated.
// Founder sees the nav item and both tabs render from the API payloads; an ops session has
// no nav item and a #analytics deep link bounces to Bookings. Offline: whoami + analytics
// endpoints are stubbed (server-side 403 enforcement is covered by api's opsAnalytics.test.ts).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const FUNNEL = {
  range: { from: '2026-06-25T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z', bucket: 'day' },
  tiles: {
    created: { value: 5, prev: 2 }, sent: { value: 3, prev: 1 },
    won: { value: 1, prev: 0 },
    wonValue: { USD: 30000 }, sentValue: { USD: 87000 }, avgSentCents: { USD: 29000 },
    pipeline: { count: 2, valueCents: { USD: 45000 } },
  },
  series: [
    { bucketStart: '2026-07-20', created: 2, sent: 1, won: 0 },
    { bucketStart: '2026-07-21', created: 3, sent: 2, won: 1 },
  ],
  lostReasons: [{ reason: 'price', count: 1, valueCents: { USD: 9000 } }],
  aging: [
    { bucket: '0-2', count: 1, valueCents: { USD: 20000 } },
    { bucket: '3-7', count: 1, valueCents: { USD: 25000 } },
    { bucket: '8-14', count: 0, valueCents: {} },
    { bucket: '15+', count: 0, valueCents: {} },
  ],
  truncated: false,
};

const DEMAND = {
  range: { from: '2026-06-25T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' },
  tiles: {
    serviceMix: { private: 3, chauffeur: 1, both: 0, unrecorded: 1 },
    vehicleMix: { car: 4, van_6: 1 },
    avgTripKm: 132, kmBuckets: [
      { bucket: '<50', count: 1 }, { bucket: '50-100', count: 1 },
      { bucket: '100-200', count: 2 }, { bucket: '200+', count: 1 },
    ],
    avgPax: 2.4,
  },
  topDestinations: [{ place: 'Kandy', touches: 4, wonValueCents: { USD: 30000 } }],
  topCorridors: [{ from: 'Colombo Airport (CMB)', to: 'Kandy', count: 3, avgKm: 115 }],
  movers: [{ place: 'Ella', recent: 4, prior: 1, changePct: 300 }],
  serviceTrend: [{ bucketStart: '2026-07-13', private: 2, chauffeur: 1, both: 0 }],
  coverage: { parsed: 4, total: 5 },
  truncated: false,
};

async function bootAs(page, caps) {
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/analytics/funnel**', (r) => r.fulfill(json(FUNNEL)));
  await page.route('**/admin/ops/analytics/demand**', (r) => r.fulfill(json(DEMAND)));
}

test('founder: Analytics nav renders, Funnel tiles + chart paint, Demand tab renders', async ({ page }) => {
  await bootAs(page, ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'analytics:view']);
  await page.goto(OPS_FILE);
  await page.waitForSelector('[data-testid="analytics-nav"]', { timeout: 10000 });
  await page.click('[data-testid="analytics-nav"]');

  await page.waitForSelector('[data-testid="analytics-tiles"]');
  await expect(page.locator('[data-testid="analytics-tiles"]')).toContainText('Created');
  await expect(page.locator('[data-testid="analytics-tiles"]')).toContainText('5');
  // Money tiles are first-class: won value renders as a headline $ figure.
  await expect(page.locator('[data-testid="analytics-tiles"]')).toContainText('Won value');
  await expect(page.locator('[data-testid="analytics-tiles"]')).toContainText('$300');
  await expect(page.locator('[data-testid="analytics-chart-created"] svg')).toBeVisible();
  await expect(page.locator('#view')).toContainText('Pipeline aging');

  await page.click('#view [data-antab="demand"]');
  await page.waitForSelector('[data-testid="analytics-top-destinations"]');
  await expect(page.locator('[data-testid="analytics-top-destinations"]')).toContainText('Kandy');
  await expect(page.locator('#view')).toContainText('Ella'); // mover chip
  // Coverage caption makes the shared/unparsed exclusion visible.
  await expect(page.locator('#view')).toContainText('4 of 5 quotes');
});

test('ops role: no Analytics nav; #analytics deep link bounces to Bookings', async ({ page }) => {
  await bootAs(page, ['quote:manage', 'bookings:operate', 'bookings:read']);
  await page.goto(OPS_FILE + '#analytics');
  await page.waitForSelector('#nav [data-route="tickets"]', { timeout: 10000 });
  await expect(page.locator('[data-testid="analytics-nav"]')).toHaveCount(0);
  // Bounced: the Bookings surface is what actually painted.
  await expect(page.locator('#view')).toContainText('Bookings');
  await expect(page.locator('[data-testid="analytics-tiles"]')).toHaveCount(0);
});
