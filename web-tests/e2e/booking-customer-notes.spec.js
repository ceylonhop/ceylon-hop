import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// booking.html step 4 asks "Anything we should know?" (#f-notes: hotel name, dietary needs, surf
// gear). Until 2026-09-27 booking.js never read the box, so the note was dropped in the browser
// and never reached ops (docs/e2e-review-2026-07-11.md, lane cust-booking). The API keeps it as
// the booking's customerNotes; these pin that the page actually sends it.

test.describe("the customer's note reaches the booking", () => {
  test('the booking POST carries the note, trimmed', async ({ page }) => {
    await gotoBooking(page);
    await fillContact(page);
    await page.fill('#f-notes', '  Staying at the Galle Face Hotel.\nTwo surfboards.  ');
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    const body = JSON.parse((await reqP).postData());

    expect(body.customerNotes).toBe('Staying at the Galle Face Hotel.\nTwo surfboards.');
  });

  test('an empty note is left out of the request, never sent as a blank', async ({ page }) => {
    await gotoBooking(page);
    await fillContact(page);
    await page.fill('#f-notes', '   ');
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    const body = JSON.parse((await reqP).postData());

    expect('customerNotes' in body).toBe(false);
  });

  test('the box stops at the 1,000 characters the API accepts', async ({ page }) => {
    await gotoBooking(page);
    await expect(page.locator('#f-notes')).toHaveAttribute('maxlength', '1000');
  });
});
