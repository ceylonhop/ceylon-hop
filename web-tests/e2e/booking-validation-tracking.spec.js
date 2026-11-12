import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// Analytics review 2026-11-10: 114 people reached the payment screen and 42 pressed Pay, but a
// press the form refused ("Please enter your billing address…") left no trace, so form trouble
// could not be told apart from people simply leaving. Each refusal now reports WHICH box —
// the field name only, never what was typed.
const refusals = (page) => page.evaluate(() =>
  (window.dataLayer || []).filter((e) => e && e.event === 'checkout_field_invalid').map((e) => e.field));

test('a refused Pay press reports the box that stopped it', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep(4));
  await page.click('#pay-btn');
  await expect.poll(() => refusals(page)).toEqual(['first']);

  await fillContact(page);
  await page.fill('#f-addr', '');
  await page.click('#pay-btn');
  await expect.poll(() => refusals(page)).toEqual(['first', 'addr']);
});

test('an unticked terms box is reported too', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  await page.uncheck('#agree');
  await page.click('#pay-btn');
  await expect.poll(() => refusals(page)).toEqual(['agree']);
});

test('the event carries the field name, not what the customer typed', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  await page.fill('#f-email', 'not-an-email');
  await page.click('#pay-btn');
  const ev = await page.evaluate(() => (window.dataLayer || []).find((e) => e && e.event === 'checkout_field_invalid'));
  expect(ev).toBeTruthy();
  expect(JSON.stringify(ev)).not.toContain('not-an-email');
});
