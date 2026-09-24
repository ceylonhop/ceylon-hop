import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

/*
  Clarity (21–23 Sep 2026): the most dead-clicked text on the site was the INSIDE of the
  search result cards — "Best value · share & save", the "$27.49 / seat" price, the shared
  card's description — and the private card's vehicle rows. People treat the card as the
  button; only the button answered.

  Now a click anywhere on the scheduled shared card does what "Book a seat" does, and a click
  anywhere on a priced vehicle row does what that row's Select does. The private card as a
  whole stays inert: it offers two vehicles, so there is no single thing it could mean.
*/
const ROUTE = 'from=negombo&to=sigiriya';
const SAT = '2099-08-15', THU = '2099-08-13';
const noDupe = (page) => page.route('**/board/dupe**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"list":null}' }));

test('clicking the shared card\'s price books the seat, same as its button', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${SAT}` });
  const c = page.locator('#shared-option');
  const href = await c.getByRole('link', { name: /Book a seat/ }).getAttribute('href');
  await c.locator('.shared-price').click();
  await page.waitForURL('**/booking.html**');
  expect(page.url()).toContain(href.split('?')[1]);
});

test('clicking a vehicle row\'s name picks that vehicle, same as its Select', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${SAT}` });
  const van = page.locator('.opt-private .veh-row').nth(1);
  await expect(van.locator('a.btn')).toBeVisible();   // priced, not the skeleton
  const href = await van.locator('a.btn').getAttribute('href');
  expect(href).toContain('vehicle=van');
  await van.locator('.v-info').click();
  await page.waitForURL('**/booking.html**');
  expect(page.url()).toContain('vehicle=van');
});

test('the rest of the private card and an off-day shared card stay put', async ({ page }) => {
  await noDupe(page);
  await gotoBooking(page, { path: '/search.html', query: `${ROUTE}&date=${THU}` });
  await expect(page.locator('.opt-private .veh-row a.btn').first()).toBeVisible();
  const url = page.url();
  // a feature chip on the private card: information, not a choice
  await page.locator('.opt-private .incl .chip').first().click();
  // the off-day shared card offers several ways forward, so its body picks none of them
  await page.locator('#shared-option .shared-price').click();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
});
