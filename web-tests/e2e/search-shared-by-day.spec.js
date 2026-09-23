import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Spec 2026-09-19-shared-ride-by-day. The scheduled seat runs Wed & Sat only, and the shared
// card used to ignore the date searched: a Thursday search showed a price, pickup times and
// "Book a seat". The card now has three states — and on an off-day it offers the nearest
// guaranteed dates first, then a way to keep the date by starting a ride on the board.
const ROUTE = 'from=negombo&to=sigiriya';
const WED = '2099-08-12', THU = '2099-08-13', SAT = '2099-08-15';
const card = (page) => page.locator('#shared-option');
const noDupe = (page) => page.route('**/board/dupe**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"list":null}' }));

test('off-day: the card says so, offers the nearest guaranteed dates, then a ride of your own', async ({ page }) => {
  await noDupe(page);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  const c = card(page);
  await expect(c).toContainText('No shared ride on Thu 13 Aug');
  await expect(c.locator('.tag-top')).toHaveText('Runs Wed & Sat');
  // there is nothing to buy on a Thursday: the button is replaced, not greyed out
  await expect(c).not.toContainText('Book a seat');

  const alts = c.locator('a.sb-alt');
  await expect(alts).toHaveCount(2);
  await expect(alts.nth(0)).toContainText('Wed 12 Aug');
  await expect(alts.nth(0)).toHaveAttribute('href', `search.html?from=negombo&to=sigiriya&date=${WED}#shared-option`);
  await expect(alts.nth(1)).toContainText('Sat 15 Aug');
  await expect(alts.nth(1)).toHaveAttribute('href', `search.html?from=negombo&to=sigiriya&date=${SAT}#shared-option`);
  await expect(alts.nth(1)).toContainText('guaranteed');

  const start = c.locator('a.sb-start');
  await expect(start).toHaveAttribute('href',
    'board.html?from=Negombo&to=' + encodeURIComponent('Sigiriya / Dambulla') + `&date=${THU}&start=1`);
  await expect(c).toContainText('$0 now');
  await expect(c).toContainText('runs if 3 travellers join');
  // the two products never borrow each other's promise
  await expect(c.locator('.sb-start-wrap')).not.toContainText('guaranteed');
});

test('a running day: the card names the date, the guarantee and the payment, and sells the seat', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${SAT}` });
  const c = card(page);
  await expect(c.locator('.shared-runs')).toContainText('Runs Sat 15 Aug');
  await expect(c.locator('.shared-runs')).toContainText('guaranteed departure');
  await expect(c).toContainText('pay now to reserve your seat');
  await expect(c.getByRole('link', { name: /Book a seat/ })).toBeVisible();
  await expect(c.locator('.sb-off')).toHaveCount(0);
});

test('no date yet: running days up front, and one quiet way to the board for other days', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: ROUTE });
  const c = card(page);
  await expect(c).toContainText('Runs Wed & Sat');
  await expect(c.getByRole('link', { name: /Book a seat/ })).toBeVisible();
  const other = c.locator('a.sb-other');
  await expect(other).toHaveText(/Other days\? Start a ride/);
  await expect(other).toHaveAttribute('href', 'board.html?from=Negombo&to=' + encodeURIComponent('Sigiriya / Dambulla') + '&start=1');
});

test('a running day that is today or already gone is never offered', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2099-08-12T12:00:00Z')); // Wed 12 Aug, everywhere on earth
  await noDupe(page);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  const alts = card(page).locator('a.sb-alt');
  await expect(alts).toHaveCount(1);
  await expect(alts.first()).toContainText('Sat 15 Aug');
});

test('someone already going that day: offer their ride instead of a fresh one', async ({ page }) => {
  const list = { code: 'NS-4242', corridorId: 'airport-cultural', from: 'Negombo', to: 'Sigiriya / Dambulla', date: THU,
    slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6, seatPrice: 2749, status: 'gathering', note: null,
    cutoffAt: '2099-08-11T01:30:00.000Z', committed: 2,
    members: [{ position: 1, firstName: 'Anna', country: 'PL', photoUrl: null, isStarter: true }, { position: 2, firstName: 'Yuki', country: 'JP', photoUrl: null }] };
  await page.route('**/board/dupe**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list }) }));
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  const c = card(page);
  await expect(c.locator('.sb-going')).toContainText('2 of 3 going Thu 13 Aug');
  await expect(c.locator('a.sb-hop')).toHaveAttribute('href', 'board.html#/NS-4242');
  await expect(c.locator('a.sb-start')).toHaveCount(0);
  // the guaranteed dates stay on offer
  await expect(c.locator('a.sb-alt')).toHaveCount(2);
});

test('the board lookup only ever upgrades the card: an error leaves "Start a ride"', async ({ page }) => {
  await page.route('**/board/dupe**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(card(page).locator('a.sb-start')).toBeVisible();
  await expect(card(page).locator('.sb-going')).toHaveCount(0);
});

test('on a phone the jump link carries the running days on an off-day', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await noDupe(page);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(page.locator('a.shared-jump')).toContainText('Shared ride: Wed & Sat');
});

test('switching date lands back on the shared card, now bookable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await noDupe(page);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await card(page).locator('a.sb-alt').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`date=${SAT}`));
  // Assert the position the traveller is actually left in, not one the page is still moving
  // through: the private card above this one is a pricing skeleton for its first moments, and
  // it grows 26px when the fare lands. Wait for the page to stop moving, THEN look.
  await expect(page.locator('#results .opt-private')).not.toHaveClass(/is-pending/);
  await expect(card(page).getByRole('link', { name: /Book a seat/ })).toBeInViewport();
});
