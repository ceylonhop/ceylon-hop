import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Who has already booked the scheduled van, on the search page's shared card (owner, 2026-11-13).
// Same data and faces as the board's scheduled rows: two letters and a country flag per booking,
// from GET /board/scheduled-seats. The clock is pinned to Mon 10 Aug 2099, so the first date past
// the 7-day notice window is Mon 17 Aug and Wed 19 Aug is a bookable run.
const NOW = '2099-08-10T06:00:00Z';
const ROUTE = 'from=negombo&to=sigiriya';
const WED = '2099-08-19';
const card = (page) => page.locator('#shared-option');

async function seats(page, departures) {
  const asked = [];
  await page.route('**/board/scheduled-seats**', (r) => {
    asked.push(new URL(r.request().url()).search);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ departures }) });
  });
  return asked;
}
const van = (people, booked = people.length, time = '07:30', date = WED) =>
  ({ corridorId: 'airport-cultural', date, time, booked, people });

test('travellers already on the van show as faces with flags, above the pick-up points', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const asked = await seats(page, [van([{ ini: 'AL', country: 'Spain' }, { ini: 'LU', country: 'Germany' }])]);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${WED}` });
  const row = card(page).locator('.sb-booked');
  await expect(row).toContainText('2 travellers booked on this van');
  await expect(row.locator('.avatar')).toHaveCount(2);
  await expect(row.locator('.avatar').first()).toContainText('AL');
  await expect(row.locator('.avatar .flag').first()).toHaveText('🇪🇸');
  expect(asked[0]).toContain(`from=${WED}`);
  expect(asked[0]).toContain('days=1');
  // it sits between the run line and the pick-up points, and the seat is still for sale
  const order = await card(page).evaluate((c) => {
    const at = (s) => [...c.querySelectorAll('*')].indexOf(c.querySelector(s));
    return { runs: at('.shared-runs'), booked: at('.sb-booked'), meta: at('.shared-meta') };
  });
  expect(order.runs).toBeLessThan(order.booked);
  expect(order.booked).toBeLessThan(order.meta);
  await expect(card(page).getByRole('link', { name: /Book a seat/ })).toBeVisible();
});

test('one traveller reads in the singular', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await seats(page, [van([{ ini: 'AL', country: 'Spain' }])]);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${WED}` });
  await expect(card(page).locator('.sb-booked')).toContainText('1 traveller booked on this van');
});

test('more than three: three faces and a +N, the count is seats', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const six = ['AL', 'LU', 'SE', 'MA', 'JO', 'KI'].map((ini) => ({ ini, country: 'France' }));
  await seats(page, [van(six, 7)]);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${WED}` });
  const row = card(page).locator('.sb-booked');
  await expect(row).toContainText('7 travellers booked on this van');
  await expect(row.locator('.avatar')).toHaveCount(4);
  await expect(row.locator('.avatar').last()).toHaveText('+3');
});

test('nobody on this van — or only on another departure — leaves the card as it was', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await seats(page, [van([{ ini: 'AL', country: 'Spain' }], 1, '11:30')]);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${WED}` });
  await expect(card(page).getByRole('link', { name: /Book a seat/ })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(card(page).locator('.sb-booked')).toHaveCount(0);
});

test('a too-soon date sells no seat, so it never asks who booked', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  const asked = await seats(page, [van([{ ini: 'AL', country: 'Spain' }], 1, '07:30', '2099-08-15')]);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=2099-08-15` });
  await expect(card(page)).toContainText('Too soon for a shared seat');
  await page.waitForTimeout(300);
  expect(asked).toHaveLength(0);
  await expect(card(page).locator('.sb-booked')).toHaveCount(0);
});
