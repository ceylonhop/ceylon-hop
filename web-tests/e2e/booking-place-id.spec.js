import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, pickPlace } from './_stubs.js';

// Analytics review 2026-11-10: a customer who PICKED their hotel from Google's list had its exact
// place on the page (state.locToGeo), but the page sent only the text and the API had to find it
// again by name — which failed often enough that 46 customers in 28 days were told "we couldn't
// find your stop". The pick's Google place ID now travels with the name.
test('a picked drop-off sends its Google place ID with the estimate and the booking', async ({ page }) => {
  const intents = [];
  const { bookingBodies } = await gotoBooking(page, {
    pickGeo: { lat: 6.15, lng: 80.11 },
    captureBooking: true,
    estimate: { respond: (intent) => { intents.push(intent); return { totalCents: 10000 }; } },
  });
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await expect.poll(() => intents.some((i) => /Result/.test(i.legs[0].to))).toBe(true);
  const picked = intents.filter((i) => /Result/.test(i.legs[0].to)).pop();
  // The ID is the one Google gave for the row that was clicked (the stub numbers both alike).
  const row = /Result (\d)/.exec(picked.legs[0].to)[1];
  expect(picked.legs[0].toPlaceId).toMatch(new RegExp(`^ChIJstubPlace${row}x`));
  expect(picked.legs[0].fromPlaceId).toBeUndefined(); // the pick-up is still the area itself

  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(() => bookingBodies.length).toBeGreaterThan(0);
  expect(bookingBodies[0].toPlaceId).toBe(picked.legs[0].toPlaceId);
  expect(bookingBodies[0].to).toBe(picked.legs[0].to);
});

test('typing over a pick drops its place ID — the ID must never describe other words', async ({ page }) => {
  const intents = [];
  await gotoBooking(page, {
    pickGeo: { lat: 6.15, lng: 80.11 },
    estimate: { respond: (intent) => { intents.push(intent); return { totalCents: 10000 }; } },
  });
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await expect.poll(() => intents.some((i) => i.legs[0].toPlaceId)).toBe(true);
  await page.fill('#loc-to', 'Some guesthouse I typed');
  await page.locator('#loc-to').blur();
  await expect.poll(() => intents.some((i) => i.legs[0].to === 'Some guesthouse I typed')).toBe(true);
  const typed = intents.filter((i) => i.legs[0].to === 'Some guesthouse I typed').pop();
  expect(typed.legs[0].toPlaceId).toBeUndefined();
});
