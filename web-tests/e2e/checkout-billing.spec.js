import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, fillBilling } from './_stubs.js';

// booking.html step 4 — billing details, decline help, and what a refused checkout says.
// The pay page has had all three since 2026-08-02; the website checkout, which takes the
// same money through the same gateway, had none of them.

test.describe.configure({ mode: 'serial' });

// Everything the form needs EXCEPT billing, so a test can leave one billing box empty
// and still reach the submit.
async function fillContactOnly(page) {
  await page.evaluate(() => window.goStep && window.goStep(4));
  await page.fill('#f-first', 'Roshen');
  await page.fill('#f-last', 'W');
  await page.fill('#f-email', 'roshenw@gmail.com');
  await page.selectOption('#f-country', 'United States');
  await page.fill('#f-phone', '9176005055');
}

test.describe('billing details reach the gateway', () => {
  test('the booking POST carries the billing address, city, state and postcode', async ({ page }) => {
    await gotoBooking(page);
    await fillContact(page);
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    const body = JSON.parse((await reqP).postData());

    expect(body.billing).toEqual({
      address: '31 River Court, Apt 105',
      city: 'Jersey City',
      state: 'NJ',
      postcode: '07310',
      country: 'United States',
    });
  });

  test('an empty postcode and state are omitted, never sent as blanks', async ({ page }) => {
    await gotoBooking(page);
    await fillContactOnly(page);
    await fillBilling(page, { state: '', postcode: '' });
    await page.check('#agree');
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    const body = JSON.parse((await reqP).postData());

    // BillingInput requires a non-empty string when the key is present, so '' would 400 —
    // the same block on a Hong Kong or UAE payer, just moved to the server.
    expect(body.billing).toEqual({
      address: '31 River Court, Apt 105',
      city: 'Jersey City',
      country: 'United States',
    });
  });

  test('the cardholder name is sent when the payer says it differs from the lead passenger', async ({ page }) => {
    await gotoBooking(page);
    await fillContact(page);
    await page.check('#f-diffbill');
    await page.fill('#f-bfirst', 'Jordan');
    await page.fill('#f-blast', 'Reyes');
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    const body = JSON.parse((await reqP).postData());

    expect(body.billing.firstName).toBe('Jordan');
    expect(body.billing.lastName).toBe('Reyes');
    // The lead passenger still owns the confirmation and the driver's details.
    expect(body.customer.firstName).toBe('Roshen');
  });

  test('the cardholder name boxes stay hidden until the payer asks for them', async ({ page }) => {
    await gotoBooking(page);
    await fillContactOnly(page);
    await expect(page.locator('#f-bfirst')).toBeHidden();
    await page.check('#f-diffbill');
    await expect(page.locator('#f-bfirst')).toBeVisible();
  });

  // The phone select defaults to Sri Lanka, which is a convenience, not a statement about
  // where anyone banks. Inheriting it would put a wrong answer in the box a foreign payer is
  // least likely to re-read — and a wrong billing country is a weaker AVS check, which is
  // the whole reason this block exists. The pay page settled this on 2026-08-02.
  test('the billing country starts unanswered rather than inheriting the phone default', async ({ page }) => {
    await gotoBooking(page);
    await page.evaluate(() => window.goStep && window.goStep(4));
    await expect(page.locator('#f-country')).toHaveValue('Sri Lanka');
    await expect(page.locator('#f-bcountry')).toHaveValue('');
  });

  test('the billing country follows the phone country until the payer picks one', async ({ page }) => {
    await gotoBooking(page);
    await page.evaluate(() => window.goStep && window.goStep(4));
    await page.selectOption('#f-country', 'Germany');
    await expect(page.locator('#f-bcountry')).toHaveValue('Germany');

    // Once they choose for themselves, their choice is never overwritten.
    await page.selectOption('#f-bcountry', 'France');
    await page.selectOption('#f-country', 'Italy');
    await expect(page.locator('#f-bcountry')).toHaveValue('France');
  });
});

test.describe('billing is required before a card is charged', () => {
  test('an empty billing address names that field and creates no booking', async ({ page }) => {
    await gotoBooking(page);
    await fillContactOnly(page);
    await fillBilling(page, { address: '' });
    await page.check('#agree');

    let posted = false;
    await page.route('**/bookings/single', (r) => { posted = true; r.abort(); });
    await page.click('#pay-btn');

    await expect(page.locator('#details-error')).toBeVisible();
    await expect(page.locator('#details-error')).toContainText('billing address');
    expect(posted).toBe(false);
  });

  test('an empty billing city names that field', async ({ page }) => {
    await gotoBooking(page);
    await fillContactOnly(page);
    await fillBilling(page, { city: '' });
    await page.check('#agree');
    await page.click('#pay-btn');
    await expect(page.locator('#details-error')).toContainText('billing city');
  });
});

test.describe('a declined card gets something to do about it', () => {
  test('a PayHere error shows the decline steps', async ({ page }) => {
    await gotoBooking(page, { checkout: 'payhere', payhere: 'error' });
    await fillContact(page);
    await page.click('#pay-btn');

    await expect(page.locator('#ph-help')).toBeVisible();
    await expect(page.locator('#ph-help')).toContainText('banking app');
    await expect(page.locator('#ph-help li')).toHaveCount(4);
  });

  test('a closed PayHere window shows them too — the SDK cannot tell the two apart', async ({ page }) => {
    await gotoBooking(page, { checkout: 'payhere', payhere: 'dismissed' });
    await fillContact(page);
    await page.click('#pay-btn');

    await expect(page.locator('#ph-msg')).toContainText('cancelled');
    await expect(page.locator('#ph-help')).toBeVisible();
  });

  test('a failure BEFORE the gateway gets no bank advice', async ({ page }) => {
    // Four paragraphs about phoning your bank, for a booking that never reached a card.
    await gotoBooking(page, { bookingStatus: 500 });
    await fillContact(page);
    await page.click('#pay-btn');

    await expect(page.locator('#ph-msg')).toContainText('couldn’t start your booking');
    await expect(page.locator('#ph-help')).toBeHidden();
  });
});

test.describe('a completed PayHere popup is not treated as a paid booking', () => {
  test('the booked screen waits for the server webhook state', async ({ page }) => {
    await gotoBooking(page, {
      checkout: 'payhere',
      payhere: 'completed',
      settlementStatuses: ['pending', 'paid'],
    });
    await fillContact(page);
    await page.click('#pay-btn');

    await expect(page.locator('#ph-msg')).toContainText('Confirming your payment');
    await expect(page.locator('#confirm')).toBeHidden();
    await expect(page.locator('#confirm')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('a refused checkout says why', () => {
  test('an unpriced booking shows the server’s hand-pricing message, not "try again"', async ({ page }) => {
    await gotoBooking(page, {
      checkoutError: {
        status: 409,
        body: {
          error: 'awaiting_price',
          message: "We're confirming the price for this trip by hand — we'll message you shortly with the final amount.",
        },
      },
    });
    await fillContact(page);
    await page.click('#pay-btn');

    await expect(page.locator('#ph-msg')).toContainText('by hand');
    // Retrying will never work, so it must not be the advice.
    await expect(page.locator('#ph-msg')).not.toContainText('try again in a moment');
  });

  test('an already-paid booking is not offered a retry', async ({ page }) => {
    await gotoBooking(page, { checkoutError: { status: 409, body: { error: 'already_paid', status: 'paid' } } });
    await fillContact(page);
    await page.click('#pay-btn');

    await expect(page.locator('#ph-msg')).toContainText('already');
    await expect(page.locator('#ph-retry')).toBeHidden();
  });

  test('an unexplained refusal still falls back to the generic message', async ({ page }) => {
    await gotoBooking(page, { checkoutError: { status: 500, body: {} } });
    await fillContact(page);
    await page.click('#pay-btn');
    await expect(page.locator('#ph-msg')).toContainText('couldn’t start your payment');
  });
});
