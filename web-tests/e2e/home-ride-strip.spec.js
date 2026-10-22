import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// "Travel with others?" on the home page (plan 2026-10-19-ride-board-fomo, PR 2, design revised
// 2026-10-21): open shared-taxi rides that still need people, stacked, each one a link to the
// board landed on that ride. Says "shared taxi"; compares with the bus, never a private car.
const NOW = '2099-08-10T00:00:00.000Z';
const ride = (o) => ({ corridorId: 'ella-south', from: 'Ella', to: 'Mirissa', date: '2099-08-14', slot: 'morning', minSeats: 3, capacity: 6,
  seatPrice: 2800, status: 'gathering', note: null, lockedTime: null, cutoffAt: '2099-08-12T01:30:00.000Z', committed: 1,
  members: [{ firstName: 'Sam', country: 'CA', photoUrl: null }], ...o });
const LISTS = [
  ride({ code: 'HR-2', members: [{ firstName: 'Sam', country: 'CA', photoUrl: null }, { firstName: 'Ana', country: '<S>', photoUrl: null }] }),
  ride({ code: 'HR-1', corridorId: 'airport-cultural', from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla', committed: 2,
    seatPrice: 2749, cutoffAt: '2099-08-10T09:12:00.000Z',
    members: [{ firstName: 'Tom', country: 'GB', photoUrl: null }, { firstName: 'Lea', country: 'FR', photoUrl: null }] }),
  ride({ code: 'HR-5', date: '2099-08-12', cutoffAt: '2099-08-10T00:12:05.000Z' }), // closes in 12m 05s
  ride({ code: 'HR-3', status: 'confirmed', committed: 3 }),
  ride({ code: 'HR-4', cutoffAt: '2099-08-09T00:00:00.000Z' }),
];

async function stubBoard(page, body, status = 200) {
  await page.route(/\/board(\?|$)/, (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.clock.setFixedTime(new Date(NOW));
});

test('shows the open rides that need people, closest to running first, each a link to the board landed on it', async ({ page }) => {
  await stubBoard(page, { lists: LISTS });
  await page.goto('/index.html');
  await expect(page.locator('#hr-title')).toHaveText('Travel with others?');
  const cards = page.locator('#home-rides .hr-card:not(.hr-sk)');
  await expect(cards).toHaveCount(3);
  const first = cards.first();
  await expect(first.locator('.hr-route')).toContainText('Colombo Airport');
  await expect(first.locator('.hr-togo')).toHaveText('1 seat to go');
  await expect(first.locator('.hr-kind')).toContainText('Shared taxi');
  await expect(first.locator('.hr-close')).toHaveText('Names close in 9h 12m');
  await expect(first).toHaveAttribute('href', 'board.html?hl=HR-1');
  await expect(first.locator('.hr-price')).toHaveText(/^\$27\.49 a seat · or 6h by bus$/);
  // the second closes in 12m 05s — the home page says minutes, never seconds
  await expect(cards.nth(1).locator('.hr-close')).toHaveText('Names close in 12m');
  // a member's country is free text: a raw <S> would become a strike-through element, escaped it is text
  const hr2 = page.locator('#home-rides .hr-card[data-ride="HR-2"]');
  await expect(hr2.locator('.hr-flag').nth(1)).toHaveText('<S>');
  await expect(hr2.locator('s')).toHaveCount(0);
});

test('never compares with our own private car, and keeps no button or link inside a card', async ({ page }) => {
  await stubBoard(page, { lists: LISTS });
  await page.goto('/index.html');
  await expect(page.locator('#home-rides .hr-card:not(.hr-sk)')).toHaveCount(3);
  await expect(page.locator('#home-rides')).not.toContainText('private car');
  await expect(page.locator('#home-rides .hr-card button')).toHaveCount(0);
  await expect(page.locator('#home-rides .hr-card a')).toHaveCount(0);
});

test('stays hidden when the board has nothing open', async ({ page }) => {
  await stubBoard(page, { lists: [LISTS[3], LISTS[4]] });
  await page.goto('/index.html');
  await expect(page.locator('#home-rides')).toBeAttached();
  await expect(page.locator('#home-rides')).toBeHidden();
});

test('stays hidden when the board cannot be reached', async ({ page }) => {
  await stubBoard(page, { error: 'down' }, 500);
  await page.goto('/index.html');
  await expect(page.locator('#home-rides')).toBeAttached();
  await expect(page.locator('#home-rides')).toBeHidden();
});

test('on a phone the cards stack, and the page never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubBoard(page, { lists: LISTS });
  await page.goto('/index.html');
  const cards = page.locator('#home-rides .hr-card:not(.hr-sk)');
  await expect(cards).toHaveCount(3);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(Math.round(b.x)).toBe(Math.round(a.x));
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(over).toBe(false);
});
