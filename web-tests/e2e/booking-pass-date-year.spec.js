import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

// #604 gave the trip review chips a year when the leg falls outside the current one. The same
// year-less format was in two more places, found while fixing that: the chauffeur day list, and —
// the one that matters most — `pass-date`, the confirmation the customer keeps.
//
// A booking is a document about a specific day. "Sat 29 Aug" on a pass for a journey 400 days out
// is missing the only thing that distinguishes it from the same date this year.
//
// All three now share one formatter (booking.js `shortDate`). The rule is unchanged: the year
// appears only when the date is not in the current year, so an ordinary trip — booked this year,
// travelled this year — keeps the short form.

// A single transfer must fall inside the booking window — booking.js drops a ?date= beyond
// `maxBookDate`, today + 12 months, and the pass then reads "To confirm" instead of a date. So the
// far date cannot simply be "+400 days".
//
// 1 January of next year is the one date that always works: it is a different calendar year than
// today by construction, and it is always inside a 12-month window from today (at worst, when
// today is itself 1 January, it lands exactly on maxBookDate, which the guard accepts).
const THIS_YEAR = new Date().getFullYear();
const FAR = `${THIS_YEAR + 1}-01-01`;
const NEAR = futureIsoDate(30);

test('the boarding pass names the year when the journey is not in this one', async ({ page }) => {
  await gotoBooking(page, {
    query: `mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car&date=${FAR}`,
  });

  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(() => page.locator('#pass-ref').textContent(), { timeout: 8000 }).toMatch(/CH-/);

  // and it is a real date on the pass, not the "To confirm" fallback
  await expect(page.locator('#pass-date')).not.toHaveText('To confirm');
  await expect(page.locator('#pass-date')).toContainText(String(THIS_YEAR + 1));
});

test('a journey inside this year keeps the short form on the pass', async ({ page }) => {
  test.skip(Number(NEAR.slice(0, 4)) !== THIS_YEAR, 'near date has rolled into next year — nothing to assert');

  await gotoBooking(page, {
    query: `mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car&date=${NEAR}`,
  });

  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(() => page.locator('#pass-ref').textContent(), { timeout: 8000 }).toMatch(/CH-/);

  await expect(page.locator('#pass-date')).not.toContainText(String(THIS_YEAR));
});
