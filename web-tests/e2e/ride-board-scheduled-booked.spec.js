import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Paid seats on scheduled taxis (plan 2026-10-19-ride-board-fomo, PR 3): a count, never names,
// and only from 2 up. The clock is pinned to Mon 10 Aug 2099, so Wed 12 Aug is the first run.
const NOW = '2099-08-10T00:00:00.000Z';
const VAN = [
  { ini: 'MA', country: 'Spain' }, { ini: 'OL', country: 'United Kingdom' }, { ini: 'JO', country: 'Germany' },
  { ini: 'AN', country: 'France' }, { ini: 'KI', country: 'Atlantis' },
];
const SEATS = { departures: [
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 7, people: VAN },
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 7, people: VAN },
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', booked: 1, people: [{ ini: 'SA', country: 'India' }] },
] };

async function stubApi(page, seats = SEATS) {
  const asked = [];
  await page.route((u) => isApiRequest(u), (route) => {
    const u = new URL(route.request().url());
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.pathname === '/board') return json({ lists: [] });
    if (u.pathname === '/board/me') return json({ me: null });
    if (u.pathname === '/board/scheduled-seats') { asked.push(u.search); return json(seats); }
    return json({});
  });
  return asked;
}

const wedRow = (page, time) => page.locator('.rw-group', { has: page.locator('.rw-day-h', { hasText: 'Wed 12 Aug' }) })
  .locator('.rws', { has: page.locator('.rw-when', { hasText: time }) });

// The count is for a departure the API sends no faces for; faces, where present, take its place.
const COUNTS = { departures: SEATS.departures.map(({ people: _p, ...d }) => d) };

test('a busy scheduled taxi says how many have booked; a quiet one says nothing', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const asked = await stubApi(page, COUNTS);
  await page.goto('/board.html');
  await expect(wedRow(page, '07:00').locator('.rws-booked').first()).toContainText('7 booked', { timeout: 15000 });
  await expect(wedRow(page, '11:30')).toBeVisible();
  await expect(wedRow(page, '11:30').locator('.rws-booked')).toHaveCount(0);
  expect(asked[0]).toContain('from=2099-08-11');
  expect(asked[0]).toContain('days=14');
});

test('the Negombo stop of the same van shows the same count', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page, COUNTS);
  await page.goto('/board.html?from=Negombo&to=' + encodeURIComponent('Sigiriya / Dambulla'));
  await expect(wedRow(page, '07:30').locator('.rws-booked').first()).toContainText('7 booked', { timeout: 15000 });
});

test('no counts when the API has none to give', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page, {});
  await page.goto('/board.html');
  await expect(wedRow(page, '07:00')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rws-booked')).toHaveCount(0);
});

// Who booked (owner 2026-10-23): the open rides' avatar circles — two letters and a flag — on the
// scheduled row, three at most then "+N". One booker is enough for a face, though not for a count.
test('a scheduled taxi shows the faces of who booked it', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html');
  const faces = wedRow(page, '07:00').locator('.rws-kind .rws-faces');
  await expect(faces).toBeVisible({ timeout: 15000 });
  await expect(faces.locator('.avatar:not(.rw-more) .ini')).toHaveText(['MA', 'OL', 'JO']);
  await expect(faces.locator('.flag')).toHaveText(['🇪🇸', '🇬🇧', '🇩🇪']);
  await expect(faces.locator('.rw-more')).toHaveText('+2');
  const one = wedRow(page, '11:30').locator('.rws-kind .rws-faces');
  await expect(one.locator('.ini')).toHaveText(['SA']);
  await expect(one.locator('.flag')).toHaveText(['🇮🇳']);
  await expect(wedRow(page, '11:30').locator('.rws-booked')).toHaveCount(0);
  // the faces take the count's place, so the pickup point is not cut off; the label keeps it
  await expect(wedRow(page, '07:00').locator('.rws-booked')).toHaveCount(0);
  await expect(wedRow(page, '07:00')).toHaveAttribute('aria-label', /7 booked/);
});

test('on a phone the faces sit on the short line', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html');
  const row = wedRow(page, '07:00');
  await expect(row.locator('.rws-short .rws-faces')).toBeVisible({ timeout: 15000 });
  await expect(row.locator('.rws-kind .rws-faces')).toBeHidden();
  await expect(row.locator('.rws-short .rws-faces .ini')).toHaveText(['MA', 'OL', 'JO']);
  await expect(row.locator('.rws-short .rws-booked')).toHaveCount(0);
  // the sub-line is what clips (overflow hidden), so the last face must end inside it
  const box = await row.locator('.rws-short small').boundingBox();
  const last = await row.locator('.rws-short .rws-faces .rw-more').boundingBox();
  expect(last.x + last.width).toBeLessThanOrEqual(box.x + box.width);
  await expect(row.locator('.rws-short small')).toContainText('via Negombo');
});

test('no faces when the API sends no one', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page, {});
  await page.goto('/board.html');
  await expect(wedRow(page, '07:00')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rws-faces')).toHaveCount(0);
});

// 412px, not 375: beside a count the sub-line needs 217px and the 375px cell is 217px exactly on a
// Mac with Poppins — Linux CI's fallback sans is ~4% wider, so there the stop ellipsises at 375 and
// fits from 390 (measured 2026-10-23). Without a count it fits from 360 everywhere (189px needed).
test('on a phone the count keeps its place and the stop on the way drops its time to fit', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page, COUNTS);
  await page.goto('/board.html');
  const sub = wedRow(page, '07:00').locator('.rws-short small');
  await expect(sub).toHaveText('Scheduled · 7 booked · via Negombo', { timeout: 15000 });
  expect(await sub.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
});
