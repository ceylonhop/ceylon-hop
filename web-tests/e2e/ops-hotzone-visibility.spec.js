import { test, expect } from '@playwright/test';

// Hot-zone visibility (owner, 2026-07-23): "how do I know the hot rate applied?" — the engine
// annotates a boosted cost line with meta.hotZone (D9, founder-only; the server strips it for
// roles without margin:view), but the money pane never rendered it, so the only trace of a
// premium was forensic arithmetic on the leg price. The pane now shows an amber chip
// ("⚡ <town> +<pct>%") on annotated lines. Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const QUOTE = {
  id: 'q1', reference: 'Q-Q1', channel: 'ops', status: 'ready',
  product: 'private', vehicle: 'car',
  customerName: 'Roshen Weliwatta', customerContact: '+94 77 123 4567',
  totalCents: 12751, currency: 'USD', notes: null,
  createdAt: '2026-07-20T09:00:00.000Z', updatedAt: '2026-07-20T10:00:00.000Z',
  createdBy: 'founder@e2e.test', updatedBy: 'founder@e2e.test',
  request: { tool: {
    name: 'Roshen Weliwatta', firstName: 'Roshen', lastName: 'Weliwatta',
    contact: '+94 77 123 4567', vehicle: 'car', service: 'private',
    requestedService: 'private', passengerCount: 2, luggageCount: 2,
    legs: [{ category: 'transfer', from: 'Colombo Airport (CMB)', to: 'Pasikuda Beach, Sri Lanka', distanceKm: 273 }],
  } },
  result: { totalCents: 12751 },
  estimate: {
    product: 'private', total: { cents: 12751, lkr: 'LKR 42,078' },
    lineItems: [
      { label: 'Colombo Airport (CMB) → Pasikuda Beach, Sri Lanka (car)', amountCents: 12751,
        meta: { distanceKm: 273, billableKm: 288, vehicle: 'car',
          hotZone: { placeName: 'Pasikuda Beach, Sri Lanka', boostPct: 10, label: 'Pasikuda Beach, Sri Lanka premium +10%' } } },
      { label: 'Highway tolls', amountCents: 500, meta: {} },
    ],
    warnings: [],
  },
};

test('a hot-zone-boosted cost line shows the premium chip; clean lines do not', async ({ page }) => {
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
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route(/\/admin\/quote\/q1$/, (r) => r.fulfill(json(QUOTE)));

  // Deep-link into the saved quote: ready → rate-locked, the pane renders q.estimate as-is.
  await page.goto(OPS_FILE + '?quote=q1#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  const chip = page.locator('.ch-hz-chip');
  await expect(chip).toHaveCount(1, { timeout: 10000 }); // boosted line only — the tolls line stays clean
  await expect(chip).toContainText('Pasikuda Beach, Sri Lanka +10%');
  await expect(chip).toHaveAttribute('title', /premium \+10%/);
  // It sits inside the boosted line's label, next to the leg description.
  const inLine = await chip.evaluate((el) =>
    !!el.closest('.ch-line') && el.closest('.ch-line').textContent.includes('Pasikuda Beach'));
  expect(inLine).toBe(true);
});
