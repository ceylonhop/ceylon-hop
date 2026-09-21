import { test, expect } from '@playwright/test';

/*
  Task B3: choosing a vehicle on the fares card decides what BOTH booking links (the card's
  CTA and the phone book bar's) carry — vehicle, price, and rawPrice only while the catalogue
  fare is what's shown (route-page-fares.js explains why: booking.js reads rawPrice FIRST).

  route-page-fares.js (B3's other half) now only writes the two engine fares into every
  [data-fare] element, sets data-engine-car/data-engine-van (cents) on the card, and dispatches
  `ch:fares` — it no longer rewrites any href. route-page-select.js owns both hrefs and the
  mobile book bar's visibility.
*/

const stubHealth = (page) =>
  page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

const engine = (page, { car, van, delayMs = 0 }) =>
  page.route('**/quote/v2/estimate', async (r) => {
    const intent = JSON.parse(r.request().postData() || '{}');
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ totalCents: intent.vehicle === 'van' ? van : car, legs: [] }),
    }).catch(() => {});
  });

const q = (href) => new URLSearchParams(href.split('?')[1]);
const pending = (page) => page.evaluate(() => document.documentElement.classList.contains('fares-pending'));

test('choosing the van books the van at the engine fare, with no catalogue rawPrice riding along', async ({ page }) => {
  await engine(page, { car: 6600, van: 8900 });
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');
  await expect(page.locator('.fares [data-fare=van]')).toHaveText('$89');
  await page.locator('input[name=vehicle][value=van]').check();
  const p = q(await page.locator('.fares a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe('van');
  expect(p.get('price')).toBe('89');
  expect(p.has('rawPrice')).toBe(false);
  expect(p.get('mode')).toBe('private');
});

test('with the engine off, the van books at the catalogue fare and keeps its rawPrice', async ({ page }) => {
  await page.goto('/trip/kandy-to-ella/?api=off');
  const card = page.locator('.fares');
  await page.locator('input[name=vehicle][value=van]').check();
  const p = q(await card.locator('a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe('van');
  expect(p.get('price')).toBe(await card.getAttribute('data-cat-van'));
  expect(p.get('rawPrice')).toBe(await card.getAttribute('data-raw-van'));
});

test('select the van BEFORE the engine answers: fares-pending still lets the href track the choice, and the engine answer then wins', async ({ page }) => {
  await engine(page, { car: 6600, van: 8900, delayMs: 600 });
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');

  expect(await pending(page)).toBe(true);
  await page.locator('input[name=vehicle][value=van]').check();
  // Still pending, but the href must already reflect van + the catalogue figures (the only
  // ones known so far) — never car, never left over from the initial static markup.
  let p = q(await page.locator('.fares a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe('van');
  expect(p.get('price')).toBe(await page.locator('.fares').getAttribute('data-cat-van'));
  expect(p.get('rawPrice')).toBe(await page.locator('.fares').getAttribute('data-raw-van'));

  // The engine answers later, for the vehicle still selected (van): the href must switch to
  // the engine fare and drop rawPrice, and the bar (if it existed) would show the same number.
  await expect(page.locator('.fares [data-fare=van]')).toHaveText('$89');
  expect(await pending(page)).toBe(false);
  p = q(await page.locator('.fares a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe('van');
  expect(p.get('price')).toBe('89');
  expect(p.has('rawPrice')).toBe(false);
});

test('the 4s cap fires before a slow engine answers: the late answer is dropped, and the van still books at the catalogue fare with rawPrice', async ({ page }) => {
  test.setTimeout(45000);
  await engine(page, { car: 99900, van: 99900, delayMs: 5500 });
  await stubHealth(page);
  await page.goto('/trip/kandy-to-ella/');

  await expect.poll(() => pending(page), { timeout: 6000 }).toBe(false);
  await expect(page.locator('.fares [data-fare=car]')).toHaveText('$59.99');
  await page.locator('input[name=vehicle][value=van]').check();
  let p = q(await page.locator('.fares a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe('van');
  expect(p.get('price')).toBe(await page.locator('.fares').getAttribute('data-cat-van'));
  expect(p.get('rawPrice')).toBe(await page.locator('.fares').getAttribute('data-raw-van'));

  // Outlive the 5.5s delayed response and prove it changed nothing: a shown fare never changes.
  await page.waitForTimeout(2500);
  await expect(page.locator('.fares [data-fare=van]')).toHaveText('$79.99');
  p = q(await page.locator('.fares a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe('van');
  expect(p.get('price')).toBe(await page.locator('.fares').getAttribute('data-cat-van'));
  expect(p.get('rawPrice')).toBe(await page.locator('.fares').getAttribute('data-raw-van'));
});

test('back navigation restores the checked radio and the CTA is re-synced to match it', async ({ page }) => {
  await page.goto('/trip/kandy-to-ella/?api=off');
  await page.locator('input[name=vehicle][value=van]').check();
  let p = q(await page.locator('.fares a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe('van');

  await page.goto('/index.html');
  await page.goBack();

  const checked = await page.locator('input[name=vehicle]:checked').getAttribute('value');
  p = q(await page.locator('.fares a.opt-cta').getAttribute('href'));
  expect(p.get('vehicle')).toBe(checked);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('car fare and the CTA are on the first screen; the bar appears once the card scrolls away and follows the selection', async ({ page }) => {
    await page.goto('/trip/kandy-to-ella/?api=off');
    for (const sel of ['.fares [data-fare=car]', '.fares a.opt-cta']) {
      const box = await page.locator(sel).boundingBox();
      expect(box.y + box.height, sel).toBeLessThanOrEqual(812);
    }
    const bar = page.locator('.trip-bookbar');
    await expect(bar).toBeHidden();
    await page.locator('input[name=vehicle][value=van]').check();
    await page.locator('.faq').scrollIntoViewIfNeeded();
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-bar-label]')).toHaveText('AC van · total, fixed');
    expect(q(await bar.locator('a.bar-cta').getAttribute('href')).get('vehicle')).toBe('van');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('the bar hides again once the card scrolls back into view', async ({ page }) => {
    await page.goto('/trip/kandy-to-ella/?api=off');
    const bar = page.locator('.trip-bookbar');
    await page.locator('.faq').scrollIntoViewIfNeeded();
    await expect(bar).toBeVisible();
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await expect(bar).toBeHidden();
  });

  test('scrolled to the bottom of the page, the bar does not cover the footer', async ({ page }) => {
    await page.goto('/trip/kandy-to-ella/?api=off');
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: 'instant' }));
    // The reveal is an IntersectionObserver callback (fires after the scroll, not inside it),
    // so wait for the bar to actually be the visible thing before measuring it — the fares
    // card is long gone from the viewport by the time the page is scrolled this far.
    await expect(page.locator('.trip-bookbar')).toBeVisible();
    const overlap = await page.evaluate(() => {
      const bar = document.querySelector('.trip-bookbar');
      const foot = document.querySelector('.footer .foot-bottom');
      const b = bar.getBoundingClientRect();
      const f = foot.getBoundingClientRect();
      return f.bottom > b.top;
    });
    expect(overlap, 'the footer\'s last line sits under the fixed bar').toBe(false);
  });
});
