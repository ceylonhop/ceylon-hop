import { test, expect } from '@playwright/test';
import { gotoBooking, fillBilling } from './_stubs.js';

// A refused Pay press named the box in #details-error, but that line sat between the billing
// form and the Payment heading while focus jumped to the box — so on a phone (and on desktop)
// the customer was looking at a red box with the reason off-screen (UX review 2026-11-15).
// The message now travels to the box that failed.

test.use({ viewport: { width: 375, height: 812 } });

async function openPayment(page) {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep && window.goStep(4));
}

// The bar hides while a form box has focus (the keyboard is up), so a real customer taps Pay
// only after leaving the box.
async function tapPay(page) {
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.click('#mbar-cta');
}

// The message's box, checked against the visible viewport.
async function expectOnScreen(page, selector) {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} has no box`).not.toBeNull();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(812);
}

// True when #details-error comes after `selector` in the document with nothing but the
// failing box's own wrapper between them.
function errorFollows(page, selector) {
  return page.evaluate((sel) => {
    const err = document.getElementById('details-error');
    const el = document.querySelector(sel);
    const wrap = el.closest('.field') || el.closest('.addon');
    return err.previousElementSibling === wrap;
  }, selector);
}

test('a refused Pay press shows the reason on screen, under the box that failed', async ({ page }) => {
  await openPayment(page);
  await tapPay(page); // empty form: the first name is the first refusal

  const err = page.locator('#details-error');
  await expect(err).toContainText('first name');
  await expectOnScreen(page, '#details-error');
  await expectOnScreen(page, '#f-first');
  expect(await errorFollows(page, '#f-first')).toBe(true);
});

test('the reason follows the customer to the next box that fails', async ({ page }) => {
  await openPayment(page);
  await page.fill('#f-first', 'Maya');
  await page.fill('#f-last', 'Silva');
  await page.fill('#f-email', 'maya@example.com');
  await page.selectOption('#f-country', 'United States');
  await page.fill('#f-phone', '9176005055');
  await fillBilling(page, { city: '' });
  await tapPay(page);

  await expect(page.locator('#details-error')).toContainText('billing city');
  await expectOnScreen(page, '#details-error');
  expect(await errorFollows(page, '#f-city')).toBe(true);
});

test('an unticked terms box gets the reason right beneath it', async ({ page }) => {
  await openPayment(page);
  await page.fill('#f-first', 'Maya');
  await page.fill('#f-last', 'Silva');
  await page.fill('#f-email', 'maya@example.com');
  await page.selectOption('#f-country', 'United States');
  await page.fill('#f-phone', '9176005055');
  await fillBilling(page);
  await tapPay(page);

  await expect(page.locator('#details-error')).toContainText('tick the box');
  await expectOnScreen(page, '#details-error');
  expect(await errorFollows(page, '#agree')).toBe(true);
});
