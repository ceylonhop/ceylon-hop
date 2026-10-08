import { test, expect } from '@playwright/test';

// Rates editor (spec 2026-09-26 §6–§7, PR 4): the founder sets prices on the Rates page through a
// review step; every save is a revision the history can revert. Offline: GET/POST /admin/rates and
// /admin/rates/preview are stubbed (the API's own rules — limits, stale-base 409, founder-only —
// are covered by api's opsRates.test.ts).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const FOUNDER = ['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'payments:reverse', 'analytics:view', 'rates:manage'];
const RATES = {
  perKmCents: { car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 },
  costPerKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  floorCents: { car: 2900, van: 4999, van9: 4999, van14: 8500, custom: 11000 },
  dayRateCents: 3105,
  dayRateCostCents: 2700,
  extrasCents: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  bufferPct: 10,
  fxUsdToLkr: 330,
};
const withCar = (car) => ({ ...RATES, perKmCents: { ...RATES.perKmCents, car } });
const defaultsBody = () => ({
  live: { version: '2026-07-14', source: 'defaults', rates: RATES, createdBy: null, createdAt: null },
  defaults: { version: '2026-07-14', rates: RATES },
  history: [],
  readOnly: { depositPct: 10, depositMinCents: 5000, depositEligibleMinCents: 15000 },
});
const revision = (seq, day, rates, extra = {}) => ({
  id: 'r' + seq, seq, version: `2026-09-${day}.${seq}`, rates, revertedToVersion: null,
  createdBy: 'roshen@ceylonhop.com', createdAt: `2026-09-${day}T10:05:00.000Z`, ...extra,
});
const SAMPLES = [
  { label: '30 km car transfer', currentCents: 2900, proposedCents: 2900 },
  { label: '150 km car transfer', currentCents: 6650, proposedCents: 7400 },
  { label: '150 km van transfer', currentCents: 8900, proposedCents: 8900 },
  { label: '3-day car chauffeur trip, 3 × 100 km', currentCents: 22800, proposedCents: 24000 },
];

// Boots the founder shell on #rates. `body()` answers GET /admin/rates (called again after a save);
// `save` answers POST /admin/rates. Every POST body is recorded.
async function boot(page, { caps = FOUNDER, body = defaultsBody, save } = {}) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {}, TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}) },
    };
  });
  const posts = [];
  let gets = 0;
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'roshen@ceylonhop.com', role: 'founder', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/quote/zones', (r) => r.fulfill(json({ zones: [], disabled: false })));
  await page.route('**/admin/rates/preview', (r) => r.fulfill(json({ samples: SAMPLES })));
  await page.route('**/admin/rates', (r) => {
    if (r.request().method() === 'GET') { gets++; return r.fulfill(json(body(gets))); }
    posts.push(r.request().postDataJSON());
    return r.fulfill(save ? save(posts.at(-1)) : json({ revision: revision(1, 27, posts.at(-1).rates) }, 201));
  });
  await page.goto(OPS_FILE + '#rates');
  await expect(page.locator('[data-testid="rates-live"]')).toBeVisible({ timeout: 10000 });
  return { posts, gets: () => gets };
}
const review = (page) => page.locator('[data-testid="rates-review"]');

test('view: exact per-km prices, margins, and a read-only deposit', async ({ page }) => {
  await boot(page);
  const pageEl = page.locator('[data-testid="rates-page"]');
  await expect(page.locator('[data-testid="rates-live"]')).toContainText('code defaults');
  await expect(page.locator('[data-testid="rates-live"]')).toContainText('2026-07-14');
  await expect(pageEl).toContainText('$0.4025');
  await expect(pageEl).toContainText('$0.5405');
  await expect(pageEl).toContainText('$0.552');
  await expect(page.locator('[data-margin-for="car"]')).toHaveText('margin 15%');
  await expect(page.locator('[data-margin-for="day"]')).toHaveText('margin 15%');
  await expect(pageEl).toContainText('optional on private & chauffeur trips from $150.00');
  await expect(page.locator('[data-action="rtEdit"]')).toBeVisible();
  await expect(page.locator('[data-testid="rates-history-defaults"]')).toContainText('Code defaults');
});

test('edit → review lists only what changed → save posts the exact set and shows the new version', async ({ page }) => {
  const saved = revision(1, 27, { ...withCar(45), extrasCents: { ...RATES.extrasCents, waiting: 1200 } });
  const { posts, gets } = await boot(page, {
    body: (n) => (n === 1 ? defaultsBody() : { ...defaultsBody(), live: { version: saved.version, source: 'revision', rates: saved.rates, createdBy: saved.createdBy, createdAt: saved.createdAt }, history: [saved] }),
  });
  await page.click('[data-action="rtEdit"]');
  await expect(page.locator('#rt-km-car')).toHaveValue('0.4025'); // exact, not the rounded $0.40
  await page.fill('#rt-km-car', '0.45');
  await expect(page.locator('[data-margin-for="car"]')).toHaveText('margin 28.6%'); // follows the typing
  await page.fill('#rt-x-waiting', '12');
  await page.click('[data-action="rtReview"]');

  await expect(review(page)).toBeVisible();
  const rows = page.locator('[data-testid="rates-changes"] tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Car — price per km');
  await expect(rows.nth(0)).toContainText('$0.4025');
  await expect(rows.nth(0)).toContainText('$0.45');
  await expect(rows.nth(1)).toContainText('Waiting');
  await expect(rows.nth(1)).toContainText('$12.00');
  await expect(page.locator('[data-testid="rates-samples"] tbody tr')).toHaveCount(4);

  await page.click('[data-action="rtSave"]');
  await expect(review(page)).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].baseVersion).toBeNull();
  expect(posts[0]).not.toHaveProperty('revertedToVersion');
  // Every untouched figure goes back exactly as it came (54.05, 55.2, 201.25 …), the two edits as typed.
  expect(posts[0].rates).toEqual({ ...withCar(45), extrasCents: { ...RATES.extrasCents, waiting: 1200 } });
  await expect(page.locator('[data-testid="rates-live"]')).toContainText('2026-09-27.1');
  expect(gets()).toBe(2);
  await expect(page.locator('#rt-km-car')).toHaveCount(0); // back to the read view
});

test('the review flags a price below cost and a jump of more than 20%', async ({ page }) => {
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.30');
  await page.click('[data-action="rtReview"]');
  await expect(page.locator('[data-testid="rates-below-cost"]')).toContainText('Car: the price per km is below our cost');
  await expect(page.locator('[data-testid="rates-changes"] tbody tr.is-big')).toHaveCount(1);
});

test('a malformed figure is caught before the review opens', async ({ page }) => {
  const { posts } = await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.40255');
  await page.click('[data-action="rtReview"]');
  await expect(review(page)).toHaveCount(0);
  await expect(page.locator('#rt-km-car')).toHaveClass(/invalid/);
  await expect(page.locator('#rt-km-car').locator('xpath=ancestor::div[contains(@class,"ch-field")][1]').locator('.ch-field-err')).toContainText('4 decimals');
  await page.fill('#rt-km-car', '0.4025'); // fixing it clears the error
  await expect(page.locator('#rt-km-car')).not.toHaveClass(/invalid/);
  expect(posts).toHaveLength(0);
});

test('nothing changed: the review says so and will not save', async ({ page }) => {
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.click('[data-action="rtReview"]');
  await expect(page.locator('[data-testid="rates-no-change"]')).toBeVisible();
  await expect(page.locator('[data-action="rtSave"]')).toBeDisabled();
});

test('a stale save names who saved meanwhile and offers a reload', async ({ page }) => {
  const other = revision(1, 27, withCar(50), { createdBy: 'nimal@ceylonhop.com' });
  const { gets } = await boot(page, { save: () => json({ error: 'stale_rates', current: other }, 409) });
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.45');
  await page.click('[data-action="rtReview"]');
  await page.click('[data-action="rtSave"]');
  await expect(page.locator('[data-testid="rates-stale"]')).toContainText('2026-09-27.1');
  await expect(page.locator('[data-testid="rates-stale"]')).toContainText('nimal');
  await page.click('[data-action="rtReload"]');
  await expect(review(page)).toHaveCount(0);
  expect(gets()).toBe(2);
});

test('history lists what each version changed, and revert saves the old set with its version', async ({ page }) => {
  const r1 = revision(1, 27, withCar(45));
  const r2 = revision(2, 28, withCar(50));
  const { posts } = await boot(page, {
    body: () => ({ ...defaultsBody(), live: { version: r2.version, source: 'revision', rates: r2.rates, createdBy: r2.createdBy, createdAt: r2.createdAt }, history: [r2, r1] }),
  });
  const rows = page.locator('[data-testid="rates-history-row"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('2026-09-28.2');
  await expect(rows.nth(0)).toContainText('live');
  await expect(rows.nth(0)).toContainText('Car — price per km $0.45 → $0.50');
  await expect(rows.nth(1)).toContainText('Car — price per km $0.4025 → $0.45');
  await expect(rows.nth(0).locator('[data-action="rtRevert"]')).toHaveCount(0); // the live one
  await rows.nth(1).locator('[data-action="rtRevert"]').click();
  await expect(review(page)).toContainText('Reverting to version 2026-09-27.1');
  await page.click('[data-action="rtSave"]');
  expect(posts[0]).toEqual({ baseVersion: '2026-09-28.2', rates: withCar(45), revertedToVersion: '2026-09-27.1' });
});

test('without rates:manage the page is read-only', async ({ page }) => {
  await boot(page, { caps: FOUNDER.filter((c) => c !== 'rates:manage') });
  await expect(page.locator('[data-action="rtEdit"]')).toHaveCount(0);
  await expect(page.locator('[data-action="rtRevert"]')).toHaveCount(0);
});

test('phone width: the edit form fits the card', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  const poking = await page.locator('.ch-rates-card').evaluate((card) => {
    const edge = card.getBoundingClientRect().right;
    return [...card.querySelectorAll('input, button, .ch-badge, b')]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
      .map((el) => el.id || el.textContent.trim());
  });
  expect(poking).toEqual([]);
});

test('phone width: the review dialog sits above the side rail, not under it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => { try { localStorage.setItem('ch_ops_rail', '1'); } catch (e) {} });
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.45');
  await page.click('[data-action="rtReview"]');
  // The dialog lived inside #view (z-index 1) under the rail (z-index 2): its left edge was hidden.
  const covered = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="rates-review"] .ch-modal-head h2').getBoundingClientRect();
    const hit = document.elementFromPoint(t.left + 4, t.top + t.height / 2);
    return !(hit && hit.closest('[data-testid="rates-review"]'));
  });
  expect(covered).toBe(false);
});
