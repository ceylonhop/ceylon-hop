import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

// Friend-reported 2026-08-27 (screenshot): a 5-leg trip whose last leg had been dated a whole
// YEAR after the first. On the booking review step the two chips read "Sat 29 Aug" and
// "Fri 27 Aug" — indistinguishable. The one fact that would have caught the mistake, the year,
// was the one thing the chip left out.
//
// booking.js's fmtLeg asked for {weekday, day, month} only. Everywhere else on the page that
// prints a date — the summary's Date row, the single-transfer heading — already carries the year.
// The leg chips now do too, whenever the leg does not fall in the current year: a trip inside
// this year stays short, and anything that has slipped into another one says so.

// +400 days is more than a full year, so it always lands in a different calendar year than
// today — no matter what today is. The near date is derived, not assumed: at the end of December
// even +30 days is next year, and the assertion has to follow the real date, not a guess at it.
const NEAR = futureIsoDate(30);
const FAR = futureIsoDate(400);
const THIS_YEAR = new Date().getFullYear();

const TRIP = [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
  'nights=0,0,0',
  `dates=${NEAR},${FAR}`,
  'kms=20,20',
  'pax=2',
  'vehicle=car',
  `start=${NEAR}`,
].join('&');

test('a leg dated in another year says which year on the review chip', async ({ page }) => {
  await gotoBooking(page, { query: TRIP });

  const chips = page.locator('#trip-route .tr-leg .tr-chip').filter({ hasText: /\d/ });
  const nearChip = chips.first();
  const farChip = page.locator('#trip-route .tr-leg').nth(1).locator('.tr-chip').first();

  // The far leg is in a different year and must say so — this is the whole point.
  const farYear = Number(FAR.slice(0, 4));
  expect(farYear).not.toBe(THIS_YEAR);
  await expect(farChip).toContainText(String(farYear));

  // The near leg carries the year only if it too has slipped out of the current year, so the
  // common case (a trip inside this year) keeps the short chip it always had.
  const nearYear = Number(NEAR.slice(0, 4));
  if (nearYear === THIS_YEAR) {
    await expect(nearChip).not.toContainText(String(nearYear));
  } else {
    await expect(nearChip).toContainText(String(nearYear));
  }

  // Whatever the years, the two chips can never read identically for dates a year apart.
  expect(await nearChip.textContent()).not.toBe(await farChip.textContent());
});
