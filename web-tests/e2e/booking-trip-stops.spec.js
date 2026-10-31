import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, fillBilling } from './_stubs.js';

// A planner leg with a stop on the way arrives as a flat ?stops= chain plus `through` (the wires
// that continue the same leg). The page must show it as ONE leg, price it as one, send `via` on the
// estimate and `through` on the booking — never as two legs.
const Q = 'mode=trip&stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Ella') + '&nights=0,0,0&dates=,&through=0&pax=2&vehicle=car';

test('one leg card for a through-run, titled with the whole chain', async ({ page }) => {
  await gotoBooking(page, { query: Q });
  await expect(page.locator('.tr-leg-badge')).toHaveCount(1);
  await expect(page.locator('.tr-leg-title').first()).toContainText('Kandy');
  await expect(page.locator('.tr-leg-title').first()).toContainText('Sigiriya');
  await expect(page.locator('.tr-leg-title').first()).toContainText('Ella');
  await expect(page.locator('.tr-via')).toHaveCount(1);
});

test('the estimate carries via; the booking carries through', async ({ page }) => {
  const estimates = [];
  const { bookingBodies } = await gotoBooking(page, {
    query: Q, captureBooking: true,
    estimate: { respond: (intent) => {
      estimates.push(intent);
      return { totalCents: 9900, legs: [{ from: 'Kandy', to: 'Ella', via: ['Sigiriya / Dambulla'], distanceKm: 270, durationMin: 390 }] };
    } },
  });
  await expect.poll(() => estimates.length).toBeGreaterThan(0);
  expect(estimates[estimates.length - 1].legs).toEqual([{ from: 'Kandy', to: 'Ella', via: ['Sigiriya / Dambulla'] }]);
  await fillContact(page);
  await fillBilling(page);
  await page.locator('#pay-btn').click();
  await expect.poll(() => bookingBodies.length).toBe(1);
  expect(bookingBodies[0].through).toEqual([0]);
  expect(bookingBodies[0].stops).toEqual(['Kandy', 'Sigiriya / Dambulla', 'Ella']);
});

test('a kept long day is written into the customer notes for ops', async ({ page }) => {
  const { bookingBodies } = await gotoBooking(page, { query: Q + '&ack=0', captureBooking: true });
  await fillContact(page);
  await fillBilling(page);
  await page.locator('#pay-btn').click();
  await expect.poll(() => bookingBodies.length).toBe(1);
  expect(bookingBodies[0].customerNotes).toMatch(/Planner: kept a .* day \(Kandy → Sigiriya \/ Dambulla → Ella\)/);
});

test('a long chain title is not clipped on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const q = 'mode=trip&stops=' + encodeURIComponent('Colombo Airport (CMB)|Kandy|Sigiriya / Dambulla|Ella') + '&nights=0,0,0,0&dates=,,&through=0,1&pax=2&vehicle=car';
  await gotoBooking(page, { query: q });
  await expect(page.locator('.tr-leg-title').first()).toContainText('Ella');
  await expect.poll(() => page.locator('.tr-leg-title').first().evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
});
