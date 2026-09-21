import { test, expect } from '@playwright/test';

/*
  A route page advertises the ENGINE's fare (owner decision 2026-09-20, "Option A").

  The page is static and its fares are baked from the catalogue — but hot zones are rows in the
  prod database, so the catalogue cannot know them: Kandy → Ella said $59.99 here and charged $66
  on the booking page. search.html was fixed first (#648); this is the same rule for /trip/.

  The static markup still carries the catalogue fares (a crawler, and a traveller with no JS or
  no API, sees a complete page — route-page-unified.test.js pins that). What changes is that a
  browser holds the fare figures back until the engine answers, then writes the engine's in. It
  never shows one number and then another.
*/

const stubHealth = (page) =>
  page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const engine = (page, { car, van, delayMs = 0 }, intents = []) =>
  page.route('**/quote/v2/estimate', async (r) => {
    const intent = JSON.parse(r.request().postData() || '{}');
    intents.push(intent);
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        totalCents: intent.vehicle === 'van' ? van : car,
        legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 136, durationMin: 227 }],
      }),
    }).catch(() => {});
  });

const pending = (page) => page.evaluate(() => document.documentElement.classList.contains('fares-pending'));

test('a route page shows the engine fare everywhere it states a price, and books at it', async ({ page }) => {
  const intents = [];
  await engine(page, { car: 6600, van: 8800 }, intents);
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');

  const card = page.locator('.opt-private');
  await expect(card.locator('[data-fare="car"]')).toHaveText('$66');
  await expect(card.locator('[data-fare="van"]')).toHaveText('$88');
  expect(await pending(page)).toBe(false);

  // the FAQ answers "how much is a taxi" with the same two numbers, not the catalogue's
  // The FAQ is a <details> accordion now; the answer is in the DOM whether or not the row
  // is open, and toContainText reads the DOM, so nothing here has to click it first.
  const faq = page.locator('.faq details', { hasText: 'How much is a taxi' });
  await expect(faq).toContainText('from $66');
  await expect(faq).toContainText('from $88');
  // Scoped to THIS route's own statements. "Related routes" below lists other routes' fares
  // (Ella → Kandy is also $59.99) — list prices are a separate step, like the homepage cards.
  await expect(card).not.toContainText('$59.99');
  await expect(faq).not.toContainText('$59.99');

  // the CTA hands booking the engine fare and no unfinished catalogue figure beside it —
  // booking reads rawPrice FIRST, so a stale one would win over the price just shown
  const href = await card.locator('a.opt-cta').getAttribute('href');
  const q = new URLSearchParams(href.split('?')[1]);
  expect(q.get('price')).toBe('66');
  expect(q.get('rawPrice')).toBeNull();
  expect(q.get('from')).toBe('kandy');

  // Byte-identical to search.js's intent, so the two pages share one sessionStorage answer.
  expect(intents.map((i) => i.vehicle)).toEqual(['car', 'van']);
  expect(JSON.stringify(intents[0])).toBe(JSON.stringify({
    vehicle: 'car', product: 'private', pax: 1, bags: 0, legs: [{ from: 'Kandy', to: 'Ella' }], extras: [],
  }));
});

test('the fare figures are held back while the engine is asked — never one number, then another', async ({ page }) => {
  await engine(page, { car: 6600, van: 8800, delayMs: 700 });
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');

  expect(await pending(page)).toBe(true);
  // held back = painted transparent in place, so nothing moves when the figure lands
  const colour = () => page.locator('.opt-private [data-fare="car"]').evaluate((el) => getComputedStyle(el).color);
  expect(await colour()).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  const box = await page.locator('.opt-private a.opt-cta').boundingBox();

  await expect(page.locator('.opt-private [data-fare="car"]')).toHaveText('$66');
  expect(await pending(page)).toBe(false);
  expect(await colour()).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  const after = await page.locator('.opt-private a.opt-cta').boundingBox();
  expect(Math.abs(after.y - box.y), 'the Book button moved when the fares landed').toBeLessThanOrEqual(1);
});

test('engine off: the page shows its catalogue fares, exactly as generated', async ({ page }) => {
  await page.route('**/quote/v2/estimate', (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');

  await expect.poll(() => pending(page)).toBe(false);
  await expect(page.locator('.opt-private [data-fare="car"]')).toHaveText('$59.99');
  const href = await page.locator('.opt-private a.opt-cta').getAttribute('href');
  expect(new URLSearchParams(href.split('?')[1]).get('rawPrice')).not.toBeNull();
});

test('a slow engine never holds the fares hostage, and a late answer does not move them', async ({ page }) => {
  await engine(page, { car: 99900, van: 99900, delayMs: 5500 });
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');

  await expect.poll(() => pending(page), { timeout: 6000 }).toBe(false);
  await expect(page.locator('.opt-private [data-fare="car"]')).toHaveText('$59.99');
  await page.waitForTimeout(2500);
  await expect(page.locator('.opt-private [data-fare="car"]')).toHaveText('$59.99');
});

test('?api=off leaves the static page alone — nothing held back, nothing asked', async ({ page }) => {
  let called = 0;
  await page.route('**/quote/v2/estimate', (r) => { called += 1; return r.fulfill({ status: 200, body: '{}' }); });
  await page.goto('/trip/kandy-to-ella/?api=off');
  expect(await pending(page)).toBe(false);
  await expect(page.locator('.opt-private [data-fare="car"]')).toHaveText('$59.99');
  await page.waitForTimeout(600);
  expect(called).toBe(0);
});
