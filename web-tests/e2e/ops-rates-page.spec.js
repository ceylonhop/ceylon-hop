import { test, expect } from '@playwright/test';

// Rates page (spec 2026-09-26 §5): Rate Settings leaves the quote builder and becomes a
// founder-only page in the ops side menu. PR 1 moves it as-is — the read-only rate card and the
// hot-zones panel — so these tests pin WHERE it lives and WHO reaches it, not what it prices.
// Offline: whoami, the queue, the quotes list, the rate card and the zone list are stubbed
// (server-side 403s on the zone writes are covered by api's hotZonesRoutes.test.ts).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const FOUNDER = ['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'payments:reverse', 'analytics:view'];
const OPS = ['quote:manage', 'quote:approve_simple', 'bookings:operate', 'bookings:read'];
const FINANCE = ['quote:manage', 'bookings:read', 'payments:act'];

// The GET /admin/quote/rate-card shape (internalQuote.ts `r.get('/rate-card')`), today's values.
const RATE_CARD = {
  version: '2026-07-14',
  perKmCents: { car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 },
  floorCents: { car: 2900, van: 4999, van9: 4999, van14: 8500, custom: 11000 },
  chauffeurDayRateCents: 3105,
  bufferPct: 10,
  depositPct: 10,
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  fxUsdToLkr: 330,
  vehicle: {
    car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 8 },
    van14: { maxPax: 14, maxBags: 12 }, custom: { maxPax: 99, maxBags: 99 },
  },
};
const ZONES = { zones: [{ id: 'z1', placeName: 'Ella', boostPct: 15, active: true }], disabled: false };

// Boots the shell with `caps`. `zones` overrides the zone-list handler (to count or delay it).
async function boot(page, caps, { zones } = {}) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}),
      },
    };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json(RATE_CARD)));
  await page.route('**/admin/quote/zones', zones || ((r) => r.fulfill(json(ZONES))));
}
const ready = (page) => page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
const ratesPage = (page) => page.locator('[data-testid="rates-page"]');

test('founder: Rates closes the side menu and opens the rate card with hot zones', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#bookings');
  await ready(page);
  const nav = page.locator('[data-testid="rates-nav"]');
  await expect(nav).toBeVisible();
  await expect(nav).toHaveAttribute('title', 'Rates');
  expect(await page.locator('#nav button').evaluateAll((bs) => bs.map((b) => b.dataset.route)))
    .toEqual(['tickets', 'quotes', 'lookup', 'analytics', 'rates']);

  await nav.click();
  await expect(page.locator('#view h1')).toHaveText('Rates');
  expect(new URL(page.url()).hash).toBe('#rates');
  await expect(nav).toHaveClass(/active/);
  await expect(ratesPage(page)).toBeVisible();
  // The rate card, drawn from GET /admin/quote/rate-card — the numbers the popup showed.
  await expect(ratesPage(page).locator('.ch-rate-group-title').first()).toHaveText(/Per-km rates/i);
  await expect(ratesPage(page)).toContainText('$0.40');
  await expect(ratesPage(page)).toContainText('2026-07-14');
  // The hot-zones panel moved with it: the stubbed zone is listed and the add form is live.
  await expect(ratesPage(page).locator('.ch-hz-row')).toContainText('Ella');
  await expect(page.locator('#hz-place')).toBeVisible();
});

test('founder: a hand-typed #rates opens the page directly', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#rates');
  await ready(page);
  await expect(page.locator('#view h1')).toHaveText('Rates');
  await expect(ratesPage(page)).toBeVisible();
  await expect(page.locator('[data-testid="rates-nav"]')).toHaveClass(/active/);
});

for (const [role, caps] of [['ops', OPS], ['finance', FINANCE]]) {
  test(`${role}: no Rates item, and a hand-typed #rates bounces silently`, async ({ page }) => {
    let zoneCalls = 0;
    await boot(page, caps, { zones: (r) => { zoneCalls++; return r.fulfill(json(ZONES)); } });
    await page.goto(OPS_FILE + '#rates');
    await ready(page);
    await expect(page.locator('[data-testid="rates-nav"]')).toHaveCount(0);
    await expect(ratesPage(page)).toHaveCount(0);
    expect(new URL(page.url()).hash).not.toBe('#rates');
    expect(zoneCalls).toBe(0);
  });
}

test('a zone list that lands after leaving the page paints nothing', async ({ page }) => {
  let release;
  const gate = new Promise((res) => { release = res; });
  await boot(page, FOUNDER, { zones: async (r) => { await gate; return r.fulfill(json(ZONES)); } });
  await page.goto(OPS_FILE + '#rates');
  await ready(page);
  await expect(ratesPage(page)).toBeVisible(); // card painted; the zone list is still pending
  await page.locator('#nav [data-route="tickets"]').click();
  await expect(page.locator('#view h1')).toHaveText('Bookings');

  const landed = page.waitForResponse((res) => res.url().includes('/admin/quote/zones'));
  release();
  await landed;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50))); // let its handler run
  await expect(ratesPage(page)).toHaveCount(0);
  await expect(page.locator('#view h1')).toHaveText('Bookings');
});

test('phone width: the page fits the screen and the card stacks to one column', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#rates');
  await ready(page);
  await expect(ratesPage(page).locator('.ch-hz-row')).toContainText('Ella');
  const overflow = await page.evaluate(() => {
    const v = document.querySelector('#view');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      view: v.scrollWidth - v.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.view).toBeLessThanOrEqual(0);
  const cols = await ratesPage(page).locator('.ch-rate-grid')
    .evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);
  // Nothing may poke out of the card. The page not scrolling sideways is not enough: the zone
  // row's buttons used to run past the card's edge while still inside the 375px screen.
  const poking = await ratesPage(page).locator('.ch-rates-card').evaluate((card) => {
    const edge = card.getBoundingClientRect().right;
    return [...card.querySelectorAll('button, .ch-badge, b')]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
      .map((el) => el.textContent.trim());
  });
  expect(poking).toEqual([]);
});
