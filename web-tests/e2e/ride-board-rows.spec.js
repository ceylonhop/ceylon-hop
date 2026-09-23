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
  // a full taxi: its action ("Start another taxi") is the widest, which is what knocked columns out of line
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

  // scheduled taxis add their own day groups for the next two weeks; these rides are in 2099
  await expect(page.locator('.rw-group:has(.rw) .rw-day-h')).toHaveText(['Sat 15 Aug', 'Sun 16 Aug']);
  const first = page.locator('.rw-group:has(.rw)').first().locator('.rw');
  await expect(first.locator('.rw-when')).toHaveText([/7–9 am/, /1–3 pm/]);
  await expect(page.locator('.rw[data-code="RW-1"] .rw-state')).toContainText('3 of 4 in');
  await expect(page.locator('.rw[data-code="RW-1"] [data-view]')).toHaveText('Join');
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
    await expect(page.locator('.rw[data-code="RW-4"] [data-again]')).toHaveText('Start another taxi', { timeout: 15000 });

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
    // 110: the price sits on the time line since the route took the full width (#622)
    expect(h - route, `${code}: ${Math.round(h)}px row, ${Math.round(route)}px of it route`).toBeLessThan(110);
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

test('the create form prints a seat price as money, not a bare number', async ({ page }) => {
  // Kandy → Ella is priced by road distance at $24.50; raw concatenation printed "$24.5 / each"
  // (prod, 2026-09-18). Every other price on the board goes through money().
  await stubApi(page);
  await page.goto('/board.html');
  await page.locator('#f-start').click();
  await page.locator('#c-from').selectOption('kandy');
  await page.locator('#c-to').selectOption('ella');
  await expect(page.locator('#c-est')).toHaveText(/^\$\d+(\.\d{2})? \/ each$/);
});

test('with a route chosen, the list closes with one invite to start a taxi on that route', async ({ page }) => {
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

test('pickup and drop-off are two soft tags with the ride sheet\'s markers, city first', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  const row = page.locator('.rw[data-code="RW-1"]');
  await expect(row).toBeVisible({ timeout: 15000 });
  const from = row.locator('.rw-pl.a'), to = row.locator('.rw-pl.b');
  await expect(from).toContainText('Colombo Airport');
  await expect(from.locator('.rw-q')).toHaveText('(CMB)');
  await expect(to).toContainText('Sigiriya');
  await expect(to.locator('.rw-q')).toHaveText('/ Dambulla');
  // the tag is a label, not a chip: tinted, no border
  const border = await from.evaluate((e) => getComputedStyle(e).borderTopWidth);
  expect(border).toBe('0px');
  // and on a laptop the longest pair we sell fits its column — no "Colombo Airport (CM…"
  for (const tag of [from, to]) {
    const clipped = await tag.evaluate((e) => e.scrollWidth > e.clientWidth + 1);
    expect(clipped, `${await tag.innerText()} is clipped`).toBe(false);
  }
});

test('on a phone the longest route we sell still sits on one line', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubApi(page);
  await page.goto('/board.html');
  const places = page.locator('.rw[data-code="RW-1"] .rw-places');
  await expect(places).toBeVisible({ timeout: 15000 });
  const h = (await places.boundingBox()).height;
  // one line of tags is ~30px; a wrap doubles it
  expect(h, `.rw-places is ${Math.round(h)}px tall — the route wrapped`).toBeLessThan(40);
});

// #622 shipped tags that clipped to "Colombo Airpo…" at the widths between a phone and a wide
// laptop — the no-clip check above only ran at 1280px. A place name is never cut; when the
// pair does not fit, the drop-off tag drops to a second line instead.
for (const width of [1024, 820]) {
  test(`at ${width}px no place tag is clipped`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    await page.goto('/board.html');
    await expect(page.locator('.rw').first()).toBeVisible({ timeout: 15000 });
    const clipped = await page.$$eval('.rw-pl', (els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.innerText.replace(/\n/g, ' ')));
    expect(clipped, `clipped at ${width}px: ${clipped.join(' | ')}`).toEqual([]);
    // and the qualifiers are gone at these widths — they are what tipped the longest pair over.
    // (.rw-route small{display:block} outranks a bare .rw-q rule; the hide must be as specific.)
    await expect(page.locator('.rw[data-code="RW-1"] .rw-q').first()).toBeHidden();
  });
}

// The pickup tag was tinted --pc-teal, which is also the wash of a ride you're on and within a
// hair of the hover wash — so on those rows the pill vanished and the city name floated.
// A tag must stay a visible pill on paper, on hover, and on a "mine" row.
const rgb = (s) => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
const dist = (x, y) => Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b);

test('a place tag stays visible on the hover wash and on your own ride', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html');
  const row = page.locator('.rw[data-code="RW-1"]');
  await expect(row).toBeVisible({ timeout: 15000 });
  for (const state of ['rest', 'hover', 'mine']) {
    if (state === 'hover') await row.hover();
    if (state === 'mine') await row.evaluate((r) => r.classList.add('mine'));
    const rowBg = rgb(await row.evaluate((r) => getComputedStyle(r).backgroundColor));
    for (const cls of ['a', 'b']) {
      const tagBg = rgb(await row.locator('.rw-pl.' + cls).evaluate((t) => getComputedStyle(t).backgroundColor));
      const d = dist(over(tagBg, rowBg), rowBg);
      expect(d, `${state}: tag .${cls} sits ${Math.round(d)} away from the row (needs 24+)`).toBeGreaterThanOrEqual(24);
    }
  }
});
