import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';

// Founder Health tab (spec 2026-10-13 §7): analytics:view-gated like Analytics. The founder sees the
// nav item and the page renders from the /admin/ops/health payload — heartbeats, usage against the
// caps, alerts, vendor links — and Refresh re-fetches (the page is never cached). An ops session has
// no nav item and a #health deep link bounces to the default landing. Offline: whoami + health are
// stubbed; server-side 403 enforcement is covered by api's opsHealth.test.ts.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const HEALTH = {
  generatedAt: '2026-10-13T10:00:00.000Z',
  dayBasis: 'utc',
  build: { commit: 'abc1234', startedAt: '2026-10-13T08:00:00.000Z', uptimeSec: 7200 },
  db: { sizeBytes: 21_000_000 },
  jobs: {
    watchdog: { lastRunAt: new Date(Date.now() - 6 * 60_000).toISOString(), stale: false },
    notificationsTick: { lastRunAt: new Date(Date.now() - 30 * 3600_000).toISOString(), stale: true },
  },
  alerts: {
    last24h: [{ kind: 'watchdog_stuck_pending', keys: 2 }],
    last7d: [{ kind: 'client_error', keys: 9 }, { kind: 'watchdog_stuck_pending', keys: 5 }],
  },
  carts: { paymentPending: 3, paymentPendingLast24h: 1, drafts: 2 },
  email: { today: { sent: 70, failed: 1, suppressed: 0 }, month: { sent: 1240 }, dailyLimit: 100, monthlyLimit: 3000 },
  maps: {
    today: { byKey: { 'maps.distance': 12, 'maps.places': 40 }, total: 52 },
    month: { byKey: { 'maps.distance': 300, 'maps.places': 2100 }, total: 2400 },
  },
  rateLimit: { refusedToday: 4, refusedMonth: 61 },
  links: [
    { label: 'Render — service, logs, instance hours', url: 'https://dashboard.render.com/' },
    { label: 'Resend — emails, daily volume, bounces', url: 'https://resend.com/emails' },
  ],
};

async function bootAs(page, caps, onHealth) {
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await routeOpsEstimate(page); // see _ops-estimate.js — an empty estimate throws inside render()
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/health', (r) => { if (onHealth) onHealth(); return r.fulfill(json(HEALTH)); });
}

test('founder: the Health tab renders heartbeats, usage vs caps, alerts and vendor links; Refresh re-fetches', async ({ page }, testInfo) => {
  let fetches = 0;
  await bootAs(page, ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'analytics:view'], () => { fetches++; });
  await page.goto(OPS_FILE);
  await page.waitForSelector('[data-testid="health-nav"]', { timeout: 10000 });
  await page.click('[data-testid="health-nav"]');

  const view = page.locator('#view');
  await expect(view.locator('.qhead h1')).toHaveText('Health');
  await expect(view).toContainText('abc1234');
  await expect(view).toContainText('21 MB');
  // Heartbeats: the watchdog is fresh, the daily tick is stale and says so.
  await expect(view).toContainText('Payments watchdog');
  await expect(view).toContainText('6 min ago');
  await expect(view.locator('.hl-stale')).toContainText('h ago');
  await expect(view).toContainText('STALE');
  // Email at exactly the 70 % line → the amber bar, and the numbers against the cap.
  await expect(view).toContainText('Sent today');
  await expect(view.locator('.hl-bar.warn')).toHaveCount(1);
  await expect(view).toContainText('/ 100');
  await expect(view).toContainText('/ 3000');
  // Maps live calls per method, 429s, carts, alerts and links.
  await expect(view).toContainText('places');
  await expect(view).toContainText('2400');
  await expect(view).toContainText('429s today');
  await expect(view).toContainText('Pending carts');
  await expect(view).toContainText('client_error');
  await expect(view.locator('.hl-links a[target="_blank"][rel="noopener"]')).toHaveCount(2);
  expect(fetches).toBe(1);
  await expect(page).toHaveURL(/#health$/);

  await page.screenshot({ path: testInfo.outputPath('ops-health.png'), fullPage: true });

  await page.click('#view [data-hlrefresh]');
  await expect(view.locator('.qhead h1')).toHaveText('Health');
  await expect.poll(() => fetches).toBe(2);
});

test('ops role: no Health nav; #health deep link bounces to the default landing (Quotes)', async ({ page }) => {
  await bootAs(page, ['quote:manage', 'bookings:operate', 'bookings:read']);
  await page.goto(OPS_FILE + '#health');
  await page.waitForSelector('#nav [data-route="tickets"]', { timeout: 10000 });
  await expect(page.locator('[data-testid="health-nav"]')).toHaveCount(0);
  await expect(page.locator('#view .qhead h1')).toHaveText('Quotes');
});
