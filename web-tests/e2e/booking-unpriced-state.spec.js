import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// CH-E7EE8 and six others (15 Sep–18 Oct 2026): the estimate answered 422 quote_unpriced, the page
// treated it like a network blip, showed its own rough price and an enabled Pay button, and
// checkout then refused the booking ("we're confirming the price by hand"). Every one of those
// customers had to retry until something priced. The page must say so at once instead.

const TRIP = 'mode=trip&stops=' + encodeURIComponent('EKHO Sigiriya|Casa Selvita|Kandy') +
  '&nights=0,1,0&dates=2027-02-04,2027-02-05&pax=2&vehicle=car';
const UNPRICED = { status: 422, body: { error: 'quote_unpriced' } };

test('a trip the server cannot price has no Pay, says why, and offers a way forward', async ({ page }) => {
  await gotoBooking(page, { query: TRIP, estimate: UNPRICED });

  // The copy first: it appears only once the estimate has answered, so the Pay check below
  // can't pass merely because the first estimate is still in flight.
  const note = page.locator('#details-error');
  await expect(note).toContainText('can’t price this trip automatically');
  await expect(page.locator('#pay-btn')).toBeDisabled();
  await expect(note.locator('a', { hasText: 'Change stops' })).toHaveAttribute('href', /^plan\.html\?.*stops=/);
  await expect(note.locator('a', { hasText: 'WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\//);
});

test('a single transfer the server cannot price has no Pay either', async ({ page }) => {
  await gotoBooking(page, { estimate: UNPRICED });
  await expect(page.locator('#details-error')).toContainText('can’t price this trip automatically');
  await expect(page.locator('#pay-btn')).toBeDisabled();
  await expect(page.locator('#details-error').locator('button', { hasText: 'Change pickup or drop-off' })).toHaveCount(1);
});

test('names the stop when the API says which one it could not find', async ({ page }) => {
  await gotoBooking(page, { query: TRIP, estimate: { status: 422, body: { error: 'quote_unpriced', unresolved: ['Casa Selvita'] } } });
  await expect(page.locator('#details-error')).toContainText('We couldn’t find Casa Selvita on the map');
});

// An outage is not a refusal: the server may still price the booking, so today's fallback
// (local figure, Pay enabled) is unchanged.
test('an outage keeps today’s fallback: Pay stays enabled, no unpriced copy', async ({ page }) => {
  await gotoBooking(page, { query: TRIP, estimate: { status: 503 } });
  await expect(page.locator('#pay-btn')).toBeEnabled();
  await expect(page.locator('#details-error')).not.toContainText('can’t price this trip automatically');
});

// Analytics review 2026-11-10: 46 customers in 28 days hit "can't price", but nothing stopped them
// before the payment screen — the pick-up screen said "Your route's confirmed", Travellers showed a
// total of $0, and only Pay was disabled, its reason below the billing form. Say it where the stop
// is entered, and don't let them walk three screens into a dead end.
test('a single transfer the server cannot price is stopped on the pick-up screen, with a way forward', async ({ page }) => {
  await gotoBooking(page, { estimate: UNPRICED });
  await page.evaluate(() => window.goStep(2));
  const note = page.locator('.panel[data-panel="2"] .unpriced-early');
  await expect(note).toBeVisible();
  await expect(note).toContainText('can’t price this trip automatically');
  await expect(note.locator('button', { hasText: 'Change pickup or drop-off' })).toHaveCount(1);
  await expect(note.locator('a', { hasText: 'WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\//);
  await expect(page.locator('#n1')).toBeDisabled();
  await expect(page.locator('#s1-sub')).not.toContainText('confirmed');
  await expect(page.locator('#sum-total')).toHaveText('Price needed');
});

test('Travellers cannot continue either, in case the refusal lands after the pick-up screen', async ({ page }) => {
  await gotoBooking(page, { estimate: UNPRICED });
  await page.evaluate(() => window.goStep(3));
  await expect(page.locator('.panel[data-panel="3"] .unpriced-early')).toContainText('can’t price this trip automatically');
  await expect(page.locator('#n4')).toBeDisabled();
});

test('a trip the server cannot price is stopped before the payment screen', async ({ page }) => {
  // A trip skips the When and Where panels (.mode-trip hides 1 and 2): its first screen is panel 3.
  await gotoBooking(page, { query: TRIP, estimate: UNPRICED });
  const note = page.locator('.panel[data-panel="3"] .unpriced-early');
  await expect(note).toBeVisible();
  await expect(note).toContainText('can’t price this trip automatically');
  await expect(note.locator('a', { hasText: 'Change stops' })).toHaveAttribute('href', /^plan\.html\?.*stops=/);
  await expect(page.locator('#n4')).toBeDisabled();
});

test('an outage does not block the early screens', async ({ page }) => {
  await gotoBooking(page, { query: TRIP, estimate: { status: 503 } });
  await expect(page.locator('#n4')).toBeEnabled();
  await expect(page.locator('.unpriced-early')).toHaveCount(0);
});
