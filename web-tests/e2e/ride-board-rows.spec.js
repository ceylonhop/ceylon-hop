import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// The board as rows (spec 2026-09-18-ride-board-rows). Pins what the row layout promises:
// day headings in order, the 2-hour window, columns that never collide, and a phone row
// that stays a row.

const member = (n, c, extra = {}) => ({ firstName: n, country: c, photoUrl: null, ...extra });
const base = { corridorId: 'airport-cultural', from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla',
  minSeats: 4, capacity: 6, seatPrice: 1900, status: 'gathering', note: null, lockedTime: null,
  cutoffAt: '2099-08-10T00:00:00.000Z' };
const LISTS = [
  { ...base, code: 'RW-3', date: '2099-08-16', slot: 'morning', committed: 1, members: [member('Priya', 'CA', { isStarter: true })] },
  { ...base, code: 'RW-2', date: '2099-08-15', slot: 'afternoon', committed: 2, members: [member('Jo', 'NL', { isStarter: true }), member('So', 'ES')] },
  { ...base, code: 'RW-1', date: '2099-08-15', slot: 'morning', committed: 3,
    members: [member('Anna', 'PL', { isStarter: true }), member('Yuki', 'JP'), member('Ben', 'IE')] },
  // a full van: its action ("Start another van") is the widest, which is what knocked columns out of line
  { ...base, code: 'RW-4', date: '2099-08-16', slot: 'afternoon', status: 'confirmed', committed: 6,
    members: ['Tom', 'Ela', 'Kim', 'Nat', 'Jo', 'Sam'].map((n, i) => member(n, 'AU', { isStarter: i === 0 })) },
];

async function stubApi(page, lists = LISTS) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists }) });
    if (p === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    const hit = lists.find((l) => p === '/board/' + l.code);
    if (hit) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('rides are grouped under day headings, in date order, each showing its 2-hour window', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });

  await expect(page.locator('.rw-day-h')).toHaveText(['Sat 15 Aug', 'Sun 16 Aug']);
  const first = page.locator('.rw-group').first().locator('.rw');
  await expect(first.locator('.rw-when')).toHaveText([/7–9 am/, /1–3 pm/]);
  await expect(page.locator('.rw[data-code="RW-1"] .rw-state')).toContainText('3 of 4 in');
  await expect(page.locator('.rw[data-code="RW-1"] [data-view]')).toHaveText('Hop on');
  // no card-era markup survives
  await expect(page.locator('.lcard')).toHaveCount(0);
});

test('a row opens the ride sheet from anywhere on it, and from the keyboard', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  const row = page.locator('.rw[data-code="RW-1"]');
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('.rw-places').click();
  await expect(page.locator('body')).toHaveClass(/detail-open/);

  await page.goto('/board.html');
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/detail-open/);
});

test('at tablet width the seat state never runs into the price', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1000 });
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });

  for (const code of ['RW-1', 'RW-2', 'RW-3']) {
    const row = page.locator(`.rw[data-code="${code}"]`);
    const s = await row.locator('.rw-state').boundingBox();
    const p = await row.locator('.rw-price').boundingBox();
    const overlaps = s.x < p.x + p.width && p.x < s.x + s.width && s.y < p.y + p.height && p.y < s.y + s.height;
    expect(overlaps, `${code}: .rw-state ${JSON.stringify(s)} overlaps .rw-price ${JSON.stringify(p)}`).toBe(false);
  }
});

for (const [label, width] of [['laptop', 1280], ['tablet', 820]]) {
  test(`on a ${label} every row's columns line up, whatever its action says`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await stubApi(page);
    await page.goto('/board.html');
    await expect(page.locator('.rw[data-code="RW-4"] [data-again]')).toHaveText('Start another van', { timeout: 15000 });

    const ends = await page.$$eval('.rw .rw-price', (els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
    expect(new Set(ends).size, `price columns end at ${ends.join(', ')}px`).toBe(1);
  });
}

test('on a phone a ride stays a compact row, and Start a ride lives in the bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });

  // A long route may wrap — that is the route's business. Everything else in the row (window,
  // faces, seat state, action) stays two short lines, whatever the route does.
  for (const code of ['RW-1', 'RW-2', 'RW-3']) {
    const row = page.locator(`.rw[data-code="${code}"]`);
    const h = (await row.boundingBox()).height;
    const route = (await row.locator('.rw-route').boundingBox()).height;
    expect(h - route, `${code}: ${Math.round(h)}px row, ${Math.round(route)}px of it route`).toBeLessThan(100);
  }
  await expect(page.locator('#f-start')).toBeHidden();
  await expect(page.locator('#start-bar-btn')).toBeVisible();
});

test('on a laptop Start a ride sits in the filter bar and opens the create form', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  const start = page.locator('#f-start');
  await expect(start).toBeVisible({ timeout: 15000 });
  await start.click();
  await expect(page.locator('#m-title')).toHaveText('Start a list');
});

test('with a route chosen, the list closes with one invite to start a van on that route', async ({ page }) => {
  await stubApi(page, [LISTS[2]]);
  await page.goto('/board.html?from=' + encodeURIComponent(base.from) + '&to=' + encodeURIComponent(base.to));
  const invite = page.locator('.rw-invite');
  await expect(invite).toBeVisible({ timeout: 15000 });
  await expect(invite).toContainText('Colombo Airport (CMB) → Sigiriya / Dambulla');
  await expect(page.locator('.rw-invite')).toHaveCount(1);
});

test('with no route chosen there is no invite row in the list', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rw-invite')).toHaveCount(0);
});
