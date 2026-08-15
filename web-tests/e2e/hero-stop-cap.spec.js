import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

/*
  The hero card is a fine place to sketch a trip and a bad place to build an itinerary. Past
  five places the stop rows crowd the card, and the planner — which has room, dates and
  per-leg pricing — is the right tool. So at three mid-stops the add button stops adding rows
  and hands the whole trip over instead, carrying everything typed so far.

  Five places = pick-up + drop-off + 3 mid-stops. Switching to multi-stop seeds the first mid
  row, so two further clicks reach the cap.
*/

const PLACES = ['Colombo Airport (CMB)', 'Kandy', 'Sigiriya / Dambulla', 'Ella', 'Galle'];

async function openMulti(page) {
  await blockLiveApi(page);
  await page.goto('/index.html');
  await page.locator('#tab-multi').click();
  await page.locator('#q-from').fill(PLACES[0]);
  await page.locator('#q-to').fill(PLACES[1]);
}

const midRows = (page) => page.locator('#mid-stops .mid-stop');
const addStop = (page) => page.locator('#add-stop');

test('the add button keeps adding rows below the cap', async ({ page }) => {
  await openMulti(page);

  await expect(midRows(page)).toHaveCount(1); // seeded by the mode switch
  await expect(addStop(page)).toHaveText('Add a stop');

  await addStop(page).click();
  await expect(midRows(page)).toHaveCount(2);
  await expect(addStop(page)).toHaveText('Add a stop');
});

test('at five places the add button becomes a hand-off to the planner', async ({ page }) => {
  await openMulti(page);
  await addStop(page).click();
  await addStop(page).click();
  await expect(midRows(page)).toHaveCount(3);

  await expect(addStop(page)).toHaveText('Add more stops in the planner');
});

test('the hand-off carries every place typed so far into the planner', async ({ page }) => {
  await openMulti(page);
  await addStop(page).click();
  await addStop(page).click();

  const rows = midRows(page);
  await rows.nth(0).locator('input').fill(PLACES[2]);
  await rows.nth(1).locator('input').fill(PLACES[3]);
  await rows.nth(2).locator('input').fill(PLACES[4]);

  await addStop(page).click();
  await page.waitForURL(/plan\.html\?/);

  const stops = new URL(page.url()).searchParams.get('stops').split('|');
  // pick-up, drop-off, then the added stops in order — the planner's own onward-journey order
  expect(stops).toEqual(PLACES);
});

test('removing a stop below the cap restores the ordinary add button', async ({ page }) => {
  await openMulti(page);
  await addStop(page).click();
  await addStop(page).click();
  await expect(addStop(page)).toHaveText('Add more stops in the planner');

  await midRows(page).last().locator('.rm').click();
  await expect(midRows(page)).toHaveCount(2);
  await expect(addStop(page)).toHaveText('Add a stop');

  // and it genuinely adds again rather than staying a dead hand-off
  await addStop(page).click();
  await expect(midRows(page)).toHaveCount(3);
});
