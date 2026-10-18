import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

// CH-7EWG7 → CH-SK8U8 (2026-10-18, Clarity session 1iwhlb5). The customer picked 19 Oct, went to
// PayHere, came back with Back — and the browser did NOT restore the page from the back/forward
// cache: booking.html loaded fresh from its URL, whose `date=` was still empty. The date lived only
// in JS state, so it was gone; and a private transfer's When step let them Continue with no date
// and no "Decide later", so the booking they then paid went through undated without anyone choosing that.
//
// Two rules, one per half of that:
//  - a picked date and pick-up time are written into the address bar, so a reload brings them back;
//  - with neither a date nor "Decide later", the When step's Continue stays shut and says why.

const TRAVEL = futureIsoDate(10);

async function pickDay(page, iso) {
  const label = await page.evaluate(
    (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    iso,
  );
  const day = page.locator(`#cal .cal-day[aria-label="${label}"]`);
  for (let i = 0; i < 3 && !(await day.count()); i++) await page.click('#cal .cal-head button:last-child');
  await day.click();
}

// What the page actually sends to POST /bookings/single — the field that ended up null on CH-SK8U8.
function recordBookingBody(page) {
  const bodies = [];
  page.route('**/bookings/single', (r) => {
    bodies.push(JSON.parse(r.request().postData() || '{}'));
    return r.fallback();
  });
  return bodies;
}

test('a picked date and time come back after a reload, and the booking carries them', async ({ page }) => {
  await gotoBooking(page);
  await pickDay(page, TRAVEL);
  await page.selectOption('#dep-select', '09:00');

  const url = new URL(page.url());
  expect(url.searchParams.get('date')).toBe(TRAVEL);
  expect(url.searchParams.get('time')).toBe('09:00');

  await page.reload();
  const bodies = recordBookingBody(page);
  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(() => bodies.length, { timeout: 8000 }).toBe(1);
  expect(bodies[0].date).toBe(TRAVEL);
  expect(bodies[0].time).toBe('09:00');
});

test('a private transfer cannot leave the When step with no date and no "Decide later"', async ({ page }) => {
  await gotoBooking(page);
  await expect(page.locator('#n2')).toBeDisabled();
  await expect(page.locator('#when-blocked')).toBeVisible();
  await expect(page.locator('#when-blocked')).toContainText('Decide later');

  await page.check('#flex-date');
  await expect(page.locator('#n2')).toBeEnabled();
  await expect(page.locator('#when-blocked')).toBeHidden();

  await page.uncheck('#flex-date');
  await expect(page.locator('#n2')).toBeDisabled();

  await pickDay(page, TRAVEL);
  await expect(page.locator('#n2')).toBeEnabled();
});

test('"Decide later" still books an undated transfer when the customer chooses it', async ({ page }) => {
  await gotoBooking(page);
  await page.check('#flex-date');
  await page.click('#n2');
  const bodies = recordBookingBody(page);
  await fillContact(page);
  await page.click('#pay-btn');
  await expect.poll(() => bodies.length, { timeout: 8000 }).toBe(1);
  expect(bodies[0].date).toBeUndefined();
});
