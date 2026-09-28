import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// The promo code field on booking.html (spec docs/superpowers/specs/2026-09-24-promo-code-field-design.md).
// The estimate stub answers like POST /quote/v2/estimate (api/src/routes/quote.ts:325-349): the
// top-level total is always the FULL price ($100 here), and a code only adds a promoCode block.
// PROMO_FIELD_ENABLED stays false; each test turns the field on with the test switch.

const FULL = 10000;
const SAVE10 = { code: 'SAVE10', discountCents: 1000, totalBeforeDiscountCents: FULL, totalCents: 9000 };
const acceptSave10 = (intent) => (intent.promoCode === 'SAVE10' ? SAVE10 : { error: 'promo_code_invalid' });
const SHARED_QUERY = 'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';

// promo(intent) returns either a promoCode block, or a full stub answer when it has `status`.
function estimateStub(promo) {
  return { respond: (intent) => {
    if (!intent.promoCode) return { totalCents: FULL };
    const p = promo(intent);
    return p && p.status ? p : { totalCents: FULL, promoCode: p };
  } };
}

async function openPayment(page, { promo = acceptSave10, on = true, bookingTotal = 9000 } = {}) {
  if (on) await page.addInitScript(() => { window.CH_PROMO_FIELD = true; });
  const handles = await gotoBooking(page, { estimate: estimateStub(promo), bookingTotal });
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await fillContact(page);
  return handles;
}

async function applyCode(page, code) {
  await page.click('#promo-toggle');
  await page.fill('#promo-input', code);
  await page.click('#promo-apply');
}

function bookingBody(page) {
  return page.waitForRequest('**/bookings/single').then((r) => JSON.parse(r.postData()));
}

test('nothing shows, and no code is sent, while the switch is off', async ({ page }) => {
  const bodies = [];
  page.on('request', (r) => { if (r.url().includes('/quote/v2/estimate')) bodies.push(JSON.parse(r.postData() || '{}')); });
  await openPayment(page, { on: false });
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('#sum-promo')).toBeHidden();
  expect(bodies.every((b) => !('promoCode' in b))).toBe(true);
});

test('a shared seat never shows the field', async ({ page }) => {
  // The logic is pinned by the unit test (promoFieldOn is false for a shared seat); this guards
  // the page: with the switch on, the Payment step still draws no field.
  await page.addInitScript(() => { window.CH_PROMO_FIELD = true; });
  await gotoBooking(page, { query: SHARED_QUERY });
  await page.evaluate(() => window.goStep(4));
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('#promo-toggle')).toBeHidden();
});

test('an accepted code discounts Total and Due now, and goes with the booking', async ({ page }) => {
  const { checkoutBodies } = await openPayment(page);
  await applyCode(page, 'save10');
  await expect(page.locator('#promo-chip')).toBeVisible();
  await expect(page.locator('#promo-chip-text')).toHaveText('SAVE10 applied');
  await expect(page.locator('#sum-promo-label')).toHaveText('Promo SAVE10');
  await expect(page.locator('#sum-promo-amt')).toHaveText('−$10');
  await expect(page.locator('#sum-adamt')).toHaveText('$100'); // the car keeps its own price
  await expect(page.locator('#sum-total')).toHaveText('$90');
  await expect(page.locator('#pay-due .amt')).toHaveText('$90');

  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  const body = await bodyP;
  expect(body.promoCode).toBe('SAVE10');
  expect(body.quotedTotal).toBe(9000);
  // The booking comes back at $90, the figure shown, so the page goes straight on to checkout —
  // without Task 2's payableTotal() in the final price check it would stop on a false
  // "your price changed" and never ask for checkout.
  await expect.poll(() => checkoutBodies.length).toBe(1);
});

test('a refused code shows why, keeps the typed text and the full price, and is never sent', async ({ page }) => {
  await openPayment(page);
  await applyCode(page, 'NOPE');
  await expect(page.locator('#promo-msg')).toHaveText('That code isn’t valid.');
  await expect(page.locator('#promo-input')).toHaveValue('NOPE');
  await expect(page.locator('#sum-promo')).toBeHidden();
  await expect(page.locator('#sum-total')).toHaveText('$100');

  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  expect(await bodyP).not.toHaveProperty('promoCode');
});

test('Remove brings back the full price and an empty field', async ({ page }) => {
  await openPayment(page);
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$90');
  await page.click('#promo-remove');
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#promo-input')).toHaveValue('');
  await expect(page.locator('#promo-chip')).toBeHidden();
  await expect(page.locator('#sum-promo')).toBeHidden();
});

test('a code that stops applying after a trip change stays, says so, and comes back', async ({ page }) => {
  // Eligible for one traveller only — standing in for the vehicle minimum leaving no room.
  await openPayment(page, { promo: (intent) => (intent.pax > 1 ? { error: 'promo_code_not_eligible' } : SAVE10) });
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$90');

  await page.evaluate(() => window.goStep(3));
  await page.click('#ad-step .ctrls button:has-text("+")');
  await expect(page.locator('#sum-promo-amt')).toHaveText('Doesn’t apply');
  await expect(page.locator('#sum-total')).toHaveText('$100');

  await page.click('#ad-step .ctrls button:has-text("–")'); // the minus is an en dash (booking.html:915)
  await expect(page.locator('#sum-promo-amt')).toHaveText('−$10');
  await expect(page.locator('#sum-total')).toHaveText('$90');

  await page.evaluate(() => window.goStep(3));
  await page.click('#ad-step .ctrls button:has-text("+")');
  await page.evaluate(() => window.goStep(4));
  await expect(page.locator('#promo-chip')).toHaveClass(/\boff\b/);
  await expect(page.locator('#promo-chip-text')).toHaveText('SAVE10 · can’t be used on this booking');
  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  expect(await bodyP).not.toHaveProperty('promoCode');
});

test('when the code can’t be checked, it isn’t kept and the price shown stays', async ({ page }) => {
  await openPayment(page, { promo: () => ({ status: 500 }) });
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#promo-msg')).toHaveText('We couldn’t check your code just now, please try again.');
  await expect(page.locator('#promo-input')).toHaveValue('SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#sum-promo')).toBeHidden();
});

test('at 375px the applied chip and the summary row fit without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPayment(page);
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#promo-chip')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a code refused when the booking is made takes no payment and shows the full price', async ({ page }) => {
  await openPayment(page, { bookingTotal: FULL });
  // The first booking attempt meets a code whose last use just went; later ones fall through to
  // gotoBooking's own stub (Playwright runs the newest matching route first).
  let refused = false;
  await page.route('**/bookings/single', (r) => {
    if (refused) return r.fallback();
    refused = true;
    return r.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"promo_code_used_up"}' });
  });
  await applyCode(page, 'SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$90');

  await page.click('#pay-btn');
  await expect(page.locator('#ph-msg')).toHaveText('That code has been fully used. Your total is now the full price.');
  await expect(page.locator('#ph-retry')).toBeHidden();
  await page.click('#ph-close');

  await expect(page.locator('#promo-msg')).toHaveText('That code has been fully used.');
  await expect(page.locator('#promo-input')).toHaveValue('SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#pay-due .amt')).toHaveText('$100');

  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  const body = await bodyP;
  expect(body).not.toHaveProperty('promoCode');
  expect(body.quotedTotal).toBe(FULL);
});

test('a code refused at booking time stays refused for the rest of the visit', async ({ page }) => {
  await openPayment(page, { bookingTotal: FULL });
  let refused = false;
  await page.route('**/bookings/single', (r) => {
    if (refused) return r.fallback();
    refused = true;
    return r.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"promo_code_used_up"}' });
  });
  await applyCode(page, 'SAVE10');
  await page.click('#pay-btn');
  await expect(page.locator('#ph-msg')).toHaveText('That code has been fully used. Your total is now the full price.');
  await page.click('#ph-close');
  await expect(page.locator('#promo-msg')).toHaveText('That code has been fully used.');
  await expect(page.locator('#promo-input')).toHaveValue('SAVE10');
  await expect(page.locator('#sum-total')).toHaveText('$100');

  // ch-pricing.js caches estimate answers by intent in sessionStorage, so re-asking the server
  // about a code it already refused this visit would just replay the OLD "accepted" answer —
  // the page must remember the refusal itself and never ask again.
  const estimateBodies = [];
  page.on('request', (r) => { if (r.url().includes('/quote/v2/estimate')) estimateBodies.push(JSON.parse(r.postData() || '{}')); });

  await page.click('#promo-apply'); // the input still holds the typed "SAVE10"
  await expect(page.locator('#promo-msg')).toHaveText('That code has been fully used.');
  await expect(page.locator('#sum-total')).toHaveText('$100');
  expect(estimateBodies.some((b) => b.promoCode)).toBe(false);

  const bodyP = bookingBody(page);
  await page.click('#pay-btn');
  const body = await bodyP;
  expect(body).not.toHaveProperty('promoCode');
  expect(body.quotedTotal).toBe(FULL);
});
