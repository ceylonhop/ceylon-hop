import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

/*
  The "Due now" row is a flex row: a label on the left (service + full route) and the amount
  on the right. Money was shrinkable, so a long route name won the fight for the width and
  squeezed the amount's box below its own text — the figure then spilled out over the panel's
  rounded edge. Owner-reported on a phone (2026-08-15): "$87.50" hanging off the card.

  Measured before the fix, at 375px: the amount's box was 34px against 67px of text (33px of
  spill), and with a full Google address as the destination it collapsed to 16px against 61px
  — 45px of spill. Money is the one thing on a payment screen that must never be mangled, so
  the amount holds its width and the LABEL absorbs the squeeze.

  The assertions are deliberately self-relative (scrollWidth vs clientWidth, and the amount's
  own right edge vs the panel's content box) rather than absolute pixel widths: text width
  differs between macOS and Linux CI, and a spec pinned to measured px would flip red on the
  runner for reasons that have nothing to do with this bug.
*/

const PHONE = { width: 375, height: 812 };

// Long enough to lose the width fight — a real Google-formatted address, as the engine returns.
const LONG_DEST = 'Ratmalana Airport, New Airport Road, Dehiwala-Mount Lavinia, Sri Lanka';

async function openPaymentStep(page, { to, price }) {
  await page.setViewportSize(PHONE);
  await gotoBooking(page, {
    query: `mode=private&vehicle=car&price=${price}&from=cmb-airport&to=${encodeURIComponent(to)}&pax=2`,
  });
  await page.evaluate(() => goStep(4));
  await expect(page.locator('#pay-due .amt')).toBeVisible();
}

test.describe('the Due now figure is never squeezed off its own panel', () => {
  test('a normal route: the amount is not clipped by its own box', async ({ page }) => {
    await openPaymentStep(page, { to: 'Polonnaruwa', price: '87.50' });

    const spill = await page.locator('#pay-due .amt').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(spill, 'the amount text is wider than the box holding it').toBeLessThanOrEqual(1);
  });

  test('a full Google address as the destination still cannot squeeze the money', async ({ page }) => {
    await openPaymentStep(page, { to: LONG_DEST, price: '1234.50' });

    const m = await page.locator('#pay-due .amt').evaluate((el) => {
      const row = el.closest('#pay-due');
      const cs = getComputedStyle(row);
      const rowBox = row.getBoundingClientRect();
      const amt = el.getBoundingClientRect();
      return {
        spill: el.scrollWidth - el.clientWidth,
        // how far the figure runs past the panel's inner (padded) right edge
        pastPadding: amt.right - (rowBox.right - parseFloat(cs.paddingRight)),
      };
    });

    expect(m.spill, 'the amount text is wider than the box holding it').toBeLessThanOrEqual(1);
    expect(m.pastPadding, 'the amount runs past the panel padding').toBeLessThanOrEqual(1);
  });

  test('the label, not the money, gives up the width', async ({ page }) => {
    // The failure mode this guards against is a "fix" that stops the spill by letting the
    // amount wrap instead — "$1,234" broken across two lines is not a fixed price.
    await openPaymentStep(page, { to: LONG_DEST, price: '1234.50' });

    const lines = await page.locator('#pay-due .amt').evaluate((el) => el.getClientRects().length);
    expect(lines, 'the amount wrapped onto more than one line').toBe(1);
  });
});
