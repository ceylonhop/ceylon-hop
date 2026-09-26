import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';

// Founder analytics (spec 2026-07-23): the Analytics surface is analytics:view-gated.
// Founder sees the nav item and both tabs render from the API payloads; an ops session has
// no nav item and a #analytics deep link bounces to the default landing. Offline: whoami + analytics
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
  cohort: { created: 5, sent: 3, decided: 2, won: 1, sendRatePct: 60, winRatePct: 50 },
  lostReasons: [{ reason: 'price', count: 1, valueCents: { USD: 9000 } }],
  aging: [
    { bucket: '0-2', count: 1, valueCents: { USD: 20000 } },
    { bucket: '3-7', count: 1, valueCents: { USD: 25000 } },
    { bucket: '8-14', count: 0, valueCents: {} },
    { bucket: '15+', count: 0, valueCents: {} },
  ],
  truncated: false,
};

const OVERVIEW = {
  range: { from: '2026-06-25T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z', bucket: 'day' },
  updatedAt: '2026-07-23T12:00:00.000Z',
  tiles: {
    paidBookings: { value: 4, prev: 2 },
    grossCollected: { USD: 52000 }, refunded: { USD: 2000 }, netCollected: { USD: 50000 },
    paymentSuccessPct: { value: 80, prev: 60 },
    revenueAtRisk: { count: 1, valueCents: { USD: 4700 } }, upcomingNeedsAttention: 1,
  },
  paymentFunnel: { started: 5, gatewayOpened: 5, paid: 4, failed: 1, dismissed: 0, abandoned: 0, successRatePct: 80 },
  series: [{ bucketStart: '2026-07-22', paidBookings: 1, netCollectedCents: { USD: 12000 } }],
  operations: {
    upcoming7: 3, upcoming28: 8,
    needsAttention: [{ kind: 'payment', bookingId: 'b1', reference: 'CH-RISK1', travelDate: '2026-07-25', label: 'Payment outstanding', amountCents: 4700, currency: 'USD' }],
    rideBoard: { activeLists: 2, confirmedLists: 1, gatheringLists: 1, committedSeats: 5, seatsNeeded: 2 },
  },
  excluded: { teamBookings: 3, teamQuoteContacts: 1, seedRideLists: 7, teamRideMembers: 2 },
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
  topOrigins: [{ place: 'Colombo Airport (CMB)', count: 4 }],
  topDestinations: [{ place: 'Kandy', count: 4, touches: 4, wonValueCents: { USD: 30000 } }],
  topCorridors: [{ from: 'Colombo Airport (CMB)', to: 'Kandy', count: 3, wins: 2, winRatePct: 67, bookedValueCents: { USD: 30000 }, avgKm: 115 }],
  movers: [{ place: 'Ella', recent: 4, prior: 1, changePct: 300 }],
  serviceTrend: [{ bucketStart: '2026-07-13', private: 2, chauffeur: 1, both: 0 }],
  coverage: { parsed: 4, total: 5 },
  truncated: false,
};

async function bootAs(page, caps) {
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await routeOpsEstimate(page); // see _ops-estimate.js — an empty estimate throws inside render()
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/analytics/funnel**', (r) => r.fulfill(json(FUNNEL)));
  await page.route('**/admin/ops/analytics/demand**', (r) => r.fulfill(json(DEMAND)));
  await page.route('**/admin/ops/analytics/overview**', (r) => r.fulfill(json(OVERVIEW)));
}

test('founder: business overview, separate sales funnels, operations and demand render', async ({ page }) => {
  await bootAs(page, ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'analytics:view']);
  await page.goto(OPS_FILE);
  await page.waitForSelector('[data-testid="analytics-nav"]', { timeout: 10000 });
  await page.click('[data-testid="analytics-nav"]');

  await page.waitForSelector('[data-testid="analytics-tiles"]');
  await expect(page.locator('[data-testid="analytics-tiles"]')).toContainText('Net collected');
  await expect(page.locator('[data-testid="analytics-tiles"]')).toContainText('$500');
  await expect(page.locator('#view')).toContainText('Clean business data');
  await expect(page.locator('#view').getByRole('heading', { name: 'Needs attention', exact: true })).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText('CH-RISK1');

  await page.click('#view [data-antab="sales"]');
  await expect(page.locator('[data-testid="analytics-chart-created"] svg')).toBeVisible();
  await expect(page.locator('#view')).toContainText('Quote win rate');
  await expect(page.locator('#view')).toContainText('Booked quote value');
  await expect(page.locator('#view')).toContainText('Pipeline aging');

  await page.click('#view [data-antab="operations"]');
  await expect(page.locator('#view')).toContainText('Upcoming exceptions');
  await expect(page.locator('#view')).toContainText('CH-RISK1');

  await page.click('#view [data-antab="demand"]');
  await page.waitForSelector('[data-testid="analytics-top-destinations"]');
  await expect(page.locator('[data-testid="analytics-top-destinations"]')).toContainText('Kandy');
  await expect(page.locator('#view')).toContainText('Top origins');
  await expect(page.locator('#view')).toContainText('Vehicle demand');
  // Coverage caption makes the shared/unparsed exclusion visible.
  await expect(page.locator('#view')).toContainText('4 of 5 quotes');
});

test('ops role: no Analytics nav; #analytics deep link bounces to the default landing (Quotes)', async ({ page }) => {
  await bootAs(page, ['quote:manage', 'bookings:operate', 'bookings:read']);
  await page.goto(OPS_FILE + '#analytics');
  await page.waitForSelector('#nav [data-route="tickets"]', { timeout: 10000 });
  await expect(page.locator('[data-testid="analytics-nav"]')).toHaveCount(0);
  // Bounced: the unrecognised hash falls through to the default landing, which for a
  // quote:manage holder is the Quotes queue (landing change 2026-07-23) — not Analytics.
  await expect(page.locator('#view .qhead h1')).toHaveText('Quotes');
  await expect(page.locator('[data-testid="analytics-tiles"]')).toHaveCount(0);
});
