import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Paid seats on scheduled taxis (plan 2026-10-19-ride-board-fomo, PR 3): a count, never names,
// and only from 2 up. The clock is pinned to Mon 10 Aug 2099, so Wed 12 Aug is the first run.
const NOW = '2099-08-10T00:00:00.000Z';
const SEATS = { departures: [
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 7 },
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 7 },
  { corridorId: 'airport-cultural', date: '2099-08-12', time: '11:30', booked: 1 },
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

test('a busy scheduled taxi says how many have booked; a quiet one says nothing', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const asked = await stubApi(page);
  await page.goto('/board.html');
  await expect(wedRow(page, '07:00').locator('.rws-booked').first()).toContainText('7 booked', { timeout: 15000 });
  await expect(wedRow(page, '11:30').locator('.rws-booked')).toHaveCount(0);
  expect(asked[0]).toContain('from=2099-08-11');
  expect(asked[0]).toContain('days=14');
});

test('the Negombo stop of the same van shows the same count', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
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
