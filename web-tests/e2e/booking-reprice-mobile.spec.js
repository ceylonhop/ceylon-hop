import { test, expect } from '@playwright/test';
import { gotoBooking, pickPlace } from './_stubs.js';

/*
  An engine raise parks the new price behind an acknowledgement gate ("Got it — use $X") and
  disables Continue until it's pressed. That notice used to be injected into the summary
  sidebar — which, on a phone, is the COLLAPSED BOTTOM SHEET. Owner-reported (2026-08-15):
  correct an out-of-area pick-up, and Continue never comes back to life.

  Measured before the fix at 375x812: Continue disabled, sticky-bar Continue disabled, and the
  notice holding the only control that releases the gate sitting at y=1308 — ~500px below the
  fold, inside an element with visibility:hidden. No visible explanation anywhere on screen.

  The gate itself is deliberate (a raise must never apply silently) and is unchanged. What
  changed is where the acknowledgement lives on a phone: beside the step the customer is
  actually on. Desktop keeps the sidebar — booking-engine-price.spec.js pins that placement.
*/

const PHONE = { width: 375, height: 812 };

// A raise that the customer did NOT choose — the case the gate exists for.
const RAISE = {
  pickGeo: { lat: 6.15, lng: 80.11 },
  estimate: { respond: (intent) => ({ totalCents: /Result/.test(intent.legs[0].to) ? 20000 : 10000 }) },
};

// Genuinely on screen: painted, not visibility:hidden/display:none anywhere up the tree,
// and inside the viewport. `toBeVisible()` alone would pass on a box sitting below the fold.
const onScreen = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  if (!(r.height > 0 && r.width > 0)) return false;
  for (let p = el; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
  }
  return r.top < window.innerHeight && r.bottom > 0;
});

// html{scroll-behavior:smooth} (site.css) means the notice is still travelling when it first
// appears — poll rather than sampling one frame, or this reads as "off screen" mid-flight.
const expectOnScreen = (locator, why) => expect.poll(() => onScreen(locator), { message: why }).toBe(true);

test('on a phone, the price-raise acknowledgement is on screen with the step', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoBooking(page, RAISE);
  await expect(page.locator('#sum-total')).toHaveText('$100');

  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  // The gate is intact: the total holds and Continue is blocked.
  await expect(page.locator('#sum-total')).toHaveText('$100');
  await expect(page.locator('#n1')).toBeDisabled();

  // …and the way OUT of the gate is reachable without hunting for it.
  const note = page.locator('#engine-reprice-note');
  await expect(note).toHaveCount(1);
  await expectOnScreen(note, 'the acknowledgement is off screen or hidden');
  await expectOnScreen(note.locator('button'), 'the "Got it" button is off screen or hidden');

  // It sits with the step the customer is on, not in the collapsed summary sheet.
  await expect(note.locator('xpath=ancestor::*[contains(@class,"panel")][1]')).toHaveAttribute('data-panel', '2');
});

test('pressing it from the phone layout releases the gate', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoBooking(page, RAISE);
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await expect(page.locator('#n1')).toBeDisabled();

  await page.click('#engine-reprice-note button');

  await expect(page.locator('#sum-total')).toHaveText('$200');
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
  // the sticky bar mirrors the real button, so the customer's actual CTA is live again
  await expect(page.locator('#mbar-cta')).toBeEnabled();
});

test('the notice follows the customer to whatever step they move to', async ({ page }) => {
  // The sidebar was chosen originally because a raise can be triggered from ANY step, so an
  // inline notice must travel with the active panel rather than stranding itself on step 2.
  await page.setViewportSize(PHONE);
  await gotoBooking(page, RAISE);
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await expect(page.locator('#engine-reprice-note')).toHaveCount(1);

  await page.evaluate(() => goStep(1));

  const note = page.locator('#engine-reprice-note');
  await expect(note.locator('xpath=ancestor::*[contains(@class,"panel")][1]')).toHaveAttribute('data-panel', '1');
  await expectOnScreen(note, 'the acknowledgement was stranded on the step it fired from');
});
