import { test, expect } from '@playwright/test';

/*
  A LIST price advertises the engine's fare too (spec 2026-09-21 §6). The /trip/ index and the
  "where next" cards on every route page bake the catalogue fare into the markup; the page each
  one links to shows the engine's (hot zones live in the prod DB) — Kandy → Ella read $59.99
  here, $66 there.

  route-list-fares.js asks POST /quote/v2/estimate-batch ONCE per page for every distinct pair
  ([data-list-fare][data-from-name][data-to-name]) and writes the answers in. Same rules as
  route-page-fares.js: the <head> holds every figure transparent-but-in-place before first paint
  and releases on its own timer; a fare that has been SHOWN never changes; every failure ends
  silently at the catalogue figure already in the markup.
*/

const stubHealth = (page) => page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
const single = (page) => page.route('**/quote/v2/estimate', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalCents: 6600, legs: [] }) }));
const batch = (page, priceFor, calls = [], delayMs = 0) => page.route('**/quote/v2/estimate-batch', async (r) => {
  const body = JSON.parse(r.request().postData());
  calls.push(body);
  if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  await r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ results: body.intents.map((i) => priceFor(i.legs[0].from, i.legs[0].to)) }) }).catch(() => {});
});
const held = (page) => page.evaluate(() => document.documentElement.classList.contains('list-fares-pending'));

test('the index asks once and shows the engine fare on every row of that pair', async ({ page }) => {
  const calls = [];
  await batch(page, (f, t) => (f === 'Kandy' && t === 'Ella' ? { totalCents: 6600, currency: 'USD' } : null), calls);
  await stubHealth(page);
  await page.goto('/trip/');
  const row = page.locator('#from-kandy a.dest[href*="kandy-to-ella"] [data-list-fare]');
  await expect(row).toHaveText('$66');
  expect(calls).toHaveLength(1);
  // byte-identical key order to search.js / route-page-fares.js
  expect(Object.keys(calls[0].intents[0])).toEqual(['vehicle', 'product', 'pax', 'bags', 'legs', 'extras']);
  const pairs = calls[0].intents.map((i) => i.legs[0].from + '|' + i.legs[0].to);
  expect(new Set(pairs).size).toBe(pairs.length); // de-duplicated ("most booked" repeats a pair)
  expect(await held(page)).toBe(false);
});

test('a null result leaves that row on its catalogue figure', async ({ page }) => {
  await batch(page, () => null);
  await stubHealth(page);
  await page.goto('/trip/');
  const row = page.locator('#from-galle a.dest[href*="galle-to-mirissa"] [data-list-fare]');
  const catalogue = await row.textContent();
  await expect.poll(() => held(page)).toBe(false);
  await expect(row).toHaveText(catalogue);
});

test('404, and ?api=off, both end silently at catalogue prices', async ({ page }) => {
  await page.route('**/quote/v2/estimate-batch', (r) => r.fulfill({ status: 404, body: '' }));
  await stubHealth(page);
  await page.goto('/trip/');
  await expect.poll(() => held(page)).toBe(false);
  await expect(page.locator('#from-kandy [data-list-fare]').first()).toHaveText(/^\$\d/);
  await page.goto('/trip/?api=off');
  expect(await held(page)).toBe(false);
});

test('a shown fare never changes: an answer slower than the cap is dropped', async ({ page }) => {
  await batch(page, () => ({ totalCents: 99900, currency: 'USD' }), [], 5500);
  await stubHealth(page);
  await page.goto('/trip/');
  const row = page.locator('#from-kandy a.dest[href*="kandy-to-ella"] [data-list-fare]');
  await expect.poll(() => held(page), { timeout: 6000 }).toBe(false);
  const shown = await row.textContent();
  await page.waitForTimeout(2500);
  await expect(row).toHaveText(shown);
  expect(shown).not.toBe('$999');
});

test('a route page fills its where-next cards from the same endpoint', async ({ page }) => {
  await single(page);
  await batch(page, () => ({ totalCents: 3150, currency: 'USD' }));
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');
  await expect(page.locator('.next [data-list-fare]').first()).toHaveText('$31.50');
});
