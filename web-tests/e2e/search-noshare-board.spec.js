import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// The board lookup (#638) was wired into the off-day shared card only. A route with NO scheduled
// van — Kandy → Ella, the board's own best seller — got a static "See the ride board" link and
// never asked, so a ride already gathering for that exact date was invisible from search.
const ROUTE = 'from=kandy&to=ella';
const THU = '2099-08-13';
const panel = (page) => page.locator('.noshare');
const going = { code: 'KE-4242', corridorId: null, from: 'Kandy', to: 'Ella', date: THU,
  slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6, seatPrice: 2450, status: 'gathering', note: null,
  cutoffAt: '2099-08-11T01:30:00.000Z', committed: 2,
  members: [{ position: 1, firstName: 'Anna', country: 'PL', photoUrl: null, isStarter: true }, { position: 2, firstName: 'Yuki', country: 'JP', photoUrl: null }] };
const dupe = (page, body, status = 200) => page.route('**/board/dupe**', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));

test('no scheduled van, but someone is already going that day: search shows their ride', async ({ page }) => {
  let asked = null;
  await page.route('**/board/dupe**', (r) => { asked = new URL(r.request().url()); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: going }) }); });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  const p = panel(page);
  await expect(p.locator('.sb-going')).toContainText('2 of 3 going Thu 13 Aug');
  await expect(p.locator('.sb-going')).toContainText('needs 1 more');
  await expect(p.locator('a.sb-hop')).toHaveAttribute('href', 'board.html#/KE-4242');
  // their ride replaces the generic link, it does not sit beside it
  await expect(p.locator('a.ns-board')).toHaveCount(0);
  expect(asked.searchParams.get('from')).toBe('Kandy');
  expect(asked.searchParams.get('to')).toBe('Ella');
  expect(asked.searchParams.get('date')).toBe(THU);
});

test('nobody going yet: the panel keeps its link to the board', async ({ page }) => {
  await dupe(page, { list: null });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(panel(page).locator('a.ns-board')).toHaveAttribute('href', 'board.html?from=Kandy&to=Ella');
  await expect(panel(page).locator('.sb-going')).toHaveCount(0);
});

test('the lookup only ever upgrades the panel: an error leaves the link', async ({ page }) => {
  await dupe(page, {}, 500);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(panel(page).locator('a.ns-board')).toBeVisible();
  await expect(panel(page).locator('.sb-going')).toHaveCount(0);
});

test('a ride that is no longer gathering is never offered as "Hop on"', async ({ page }) => {
  await dupe(page, { list: { ...going, status: 'confirmed' } });
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(panel(page).locator('a.ns-board')).toBeVisible();
  await expect(panel(page).locator('a.sb-hop')).toHaveCount(0);
});

test('no date searched: nothing to match a ride against, so the board is not asked', async ({ page }) => {
  let calls = 0;
  await page.route('**/board/dupe**', (r) => { calls++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: going }) }); });
  await gotoBooking(page, { path: '/search.html', query: ROUTE });
  await expect(panel(page).locator('a.ns-board')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(calls).toBe(0);
  await expect(panel(page).locator('.sb-going')).toHaveCount(0);
});
