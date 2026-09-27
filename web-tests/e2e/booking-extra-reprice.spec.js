import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Friend-reported 2026-08-27 (screenshot, annotated "reduce from here" / "warning given?"):
// after ticking the $10 sightseeing extra the summary read
//
//     AC car (up to 3) ......... $146
//     Travellers ........ 3 · included
//     Sightseeing stops (3h) .... $10
//     Total .................... $156
//     ⚠ Your price has been updated … your total is now $166 (it was $156).
//
// Two things are wrong, and neither is the arithmetic — $156 + $10 = $166 is the correct price.
//
// 1. The customer is asked to acknowledge a raise they DROVE. handleEngineEstimate already exempts
//    the raises a press causes — switchedProductOrVehicle, "the press IS the acknowledgement, and
//    both the service chooser and the upsell CTA name their price before it happens". The extras
//    button names its price too ("+$10", right on the control). It simply was not in the list.
// 2. While the raise is parked, calcTotal() HOLDS at the old total, and the vehicle row is derived
//    as `calcTotal() − extras` so the rows always sum to it. Ticking a $10 extra therefore made
//    the car line drop by exactly $10 — the price of the car appeared to fall because the customer
//    added something. That is what the "reduce from here" arrow is pointing at.
//
// Fixing (1) removes (2) for this case: the total moves the moment they tick, and the rows sum to
// the figure on screen. A raise the customer did NOT drive is still gated — pinned below.

const BASE = 15600;
const WITH_EXTRA = 16600; // BASE + the $10 sightseeing extra

const sightseeing = (page) => page.locator('[data-addon="sightseeing"]');
const rowAmounts = async (page) => ({
  base: await page.locator('#sum-adamt').textContent(),
  total: await page.locator('#sum-total').textContent(),
  addons: await page.locator('#sum-addons').textContent(),
});

test('ticking a priced extra updates the total instead of demanding acknowledgement', async ({ page }) => {
  await gotoBooking(page, {
    estimate: {
      respond: (intent) => ({
        totalCents: (intent.extras || []).includes('sightseeing') ? WITH_EXTRA : BASE,
      }),
    },
  });

  await expect(page.locator('#sum-total')).toHaveText('$156');
  await expect(page.locator('#sum-adamt')).toHaveText('$156');

  await page.evaluate(() => window.goStep && window.goStep(3));
  await sightseeing(page).click();

  // The total moves to the new figure on its own — the extra's price was on the button.
  await expect(page.locator('#sum-total')).toHaveText('$166');
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);

  // ...and the vehicle line did NOT fall by the price of the thing they just added.
  const rows = await rowAmounts(page);
  expect(rows.base).toBe('$156');
  expect(rows.addons).toContain('$10');
  expect(rows.total).toBe('$166');

  // Continue is not gated behind an acknowledgement that no longer exists.
  await expect(page.locator('#n1')).toBeEnabled();
});

test('a raise the customer did not drive is still held for acknowledgement', async ({ page }) => {
  // Same page, but the raise comes from a pax change — nothing on that stepper names a price, so
  // the gate must stay exactly as it is. This is the rule the fix must not weaken.
  await gotoBooking(page, {
    estimate: { respond: (intent) => ({ totalCents: intent.pax >= 2 ? WITH_EXTRA : BASE }) },
  });

  await expect(page.locator('#sum-total')).toHaveText('$156');
  await page.evaluate(() => window.goStep && window.goStep(3));
  await page.click('#ad-step .ctrls button:has-text("+")');

  await expect(page.locator('#engine-reprice-note')).toBeVisible();
  await expect(page.locator('#sum-total')).toHaveText('$156');
  await expect(page.locator('#n1')).toBeDisabled();

  await page.click('#engine-reprice-note button');
  await expect(page.locator('#sum-total')).toHaveText('$166');
});

test('the vehicle line never dips while the ticked extra is being priced', async ({ page }) => {
  // The first test pins where the rows SETTLE; this one watches the way there. Until the new
  // estimate lands the total reads "Calculating…" and calcTotal() still holds the figure priced
  // WITHOUT the extra, so a vehicle line derived as that figure minus the extras now ticked
  // counted $156 → $146 and back up: the same "reduce from here", for as long as the round trip
  // takes. The delay stands in for that round trip, and keeps a dip observable even when no
  // animation frame runs (a count's backstop timer writes its target ~500ms in).
  await gotoBooking(page, {
    estimate: {
      respond: (intent) => ((intent.extras || []).includes('sightseeing')
        ? { totalCents: WITH_EXTRA, delayMs: 500 }
        : { totalCents: BASE }),
    },
  });
  await expect(page.locator('#sum-adamt')).toHaveText('$156');
  await page.evaluate(() => window.goStep && window.goStep(3));

  // Every value each figure takes from here on, so a dip that lasts a frame can't hide.
  await page.evaluate(() => {
    window.__seen = { base: [], total: [] };
    for (const [key, id] of [['base', 'sum-adamt'], ['total', 'sum-total']]) {
      const el = document.getElementById(id);
      new MutationObserver(() => window.__seen[key].push(el.textContent))
        .observe(el, { childList: true, characterData: true, subtree: true });
    }
  });
  await sightseeing(page).click();
  await expect(page.locator('#sum-total')).toHaveText('$166', { timeout: 10000 });
  await expect(page.locator('#sum-adamt')).toHaveText('$156');

  const seen = await page.evaluate(() => window.__seen);
  // The in-flight window really opened; without it the check below would pass on nothing.
  expect(seen.total.join(' | ')).toMatch(/Calculating/);
  const lowest = Math.min(...seen.base.map((t) => parseFloat(t.replace(/[^0-9.]/g, ''))));
  expect(lowest, `vehicle line read ${seen.base.join(' → ')}`).toBeGreaterThanOrEqual(156);
});
