import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// Spec 2026-09-26 §9: plan, home and why draw copy prices on first paint. With the live list
// available they show ITS numbers — held blank until it lands, never the baked ones first — and
// with it unavailable they show the baked ones once the hold lifts. In offline e2e,
// /quote/pricing reaches the static server (serve-booking.js rewrites the live API host), so
// every case stubs it explicitly.
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const LIVE = {
  perKm: { car: 1.2, van: 1.5 }, floors: { car: 29, van: 49.99 }, bufferPct: 10,
  priceFinishing: { maxReductionBps: 250, roundToCents: 50 }, chauffeurDayFee: 31.05,
  chauffeurIdleMinKm: { car: 50, van: 100 }, depositPct: 0.1, depositMin: 50,
  extras: { sightseeing: 10, 'safari-wait': 19, luggage: 5, front: 8, flex: 12, waiting: 10 },
  corridorSeat: {}, seatPricing: { perKmCentsVan: 150, floorCentsVan: 4999, seatsCoveringVan: 3 }, sharedProducts: [],
};
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

// Answers /quote/pricing with LIVE once `release()` is called (or at once), or with `status`.
async function stubPricing(page, { held = false, status = 200 } = {}) {
  let release = () => {};
  const gate = held ? new Promise((res) => { release = res; }) : Promise.resolve();
  await page.route('**/quote/pricing', async (r) => {
    await gate;
    return status === 200 ? r.fulfill(json(LIVE)) : r.fulfill({ status, body: '' });
  });
  return () => release();
}
const settled = (page) => expect(page.locator('html')).not.toHaveClass(/prices-pending/, { timeout: 5000 });
const color = (loc) => loc.evaluate((el) => getComputedStyle(el).color);

test('home: popular-transfer prices are held blank, then show the live price', async ({ page }) => {
  const release = await stubPricing(page, { held: true });
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  const fig = page.locator('#home-transfers .tc-price b').first();
  await expect(page.locator('html')).toHaveClass(/prices-pending/);
  await expect(fig).toBeAttached();
  expect(await color(fig)).toBe(TRANSPARENT);
  release();
  await settled(page);
  const expected = await page.evaluate(() => {
    const n = window.TRANSFERS.privateQuote('cmb-airport', 'kandy').car;
    const c = Math.round(n * 100);
    return '$' + (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
  });
  await expect(fig).toHaveText(expected);
  expect(await page.evaluate(() => window.TRANSFERS.PER_KM.car)).toBe(1.2);
  expect(await color(fig)).not.toBe(TRANSPARENT);
  // Updated in place, not re-rendered: the card is still the node site.js's reveal observer watches.
  const card = page.locator('#home-transfers .tcard').first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/\bin\b/);
  // The ready-made routes' "Private transport from $X" is a copy price too.
  const tourExpected = await page.evaluate(() => {
    const n = window.TRANSFERS.tripQuote(window.TOURS[0].stops, 'car').total;
    const c = Math.round(n * 100);
    return '$' + (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
  });
  await expect(page.locator('#home-tours .ht-price-value b').first()).toHaveText(tourExpected);
});

test('home: with the list unavailable the baked price shows once the hold lifts', async ({ page }) => {
  await stubPricing(page, { status: 404 });
  await page.goto('/index.html');
  await settled(page);
  expect(await page.evaluate(() => window.TRANSFERS.PER_KM.car)).toBe(0.4025);
  expect(await color(page.locator('#home-transfers .tc-price b').first())).not.toBe(TRANSPARENT);
});

test('why: the comparison shows the live car price', async ({ page }) => {
  await stubPricing(page);
  await page.goto('/why.html');
  await settled(page);
  const expected = await page.evaluate(() => window.TRANSFERS.privateQuote('cmb-airport', 'kandy').car);
  await expect(page.locator('#cmp-car')).toHaveText(`$${expected} fixed`);
  expect(expected).toBeGreaterThan(100); // 1.20/km, not the baked 0.4025/km
});

test('plan: a restored itinerary holds its leg price, then prices it on the live list', async ({ page }) => {
  await blockLiveApi(page);   // the planner's road check (estimate-batch) must not reach the API
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  const release = await stubPricing(page, { held: true });
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car', { waitUntil: 'domcontentloaded' });
  const fig = page.locator('#rail [data-dist] .lm-price b');
  await expect(fig).toBeAttached();
  expect(await color(fig)).toBe(TRANSPARENT);
  release();
  await settled(page);
  const expected = await page.evaluate(() => {
    const T = window.TRANSFERS;
    const km = T.privateQuote('kandy', 'ella').km; // the distance plan.js prices a catalogue pair on
    const n = T.finishPrice(T.legPrice(km, 'car'), T.FLOORS.car);
    const c = Math.round(n * 100);
    return '$' + (c / 100).toFixed(c % 100 === 0 ? 0 : 2);
  });
  await expect(fig).toHaveText(expected);
  expect(expected).not.toBe('$59.99'); // the baked Kandy → Ella price (plan-pricing-map.spec.js)
  await expect(page.locator('#sum-amt')).not.toHaveText('~$—');
});
