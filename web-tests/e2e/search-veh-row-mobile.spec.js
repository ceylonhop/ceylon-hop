import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

/*
  The private card's vehicle row put the fare and the Select button side by side in one
  right-hand strip. On a phone that strip is ~80px wide, so a wide fare grew into the button
  and was painted over it — owner-reported (2026-08-15): "$154.50" with Select sitting on top
  of the decimals. The squeezed name column wrapped "Up to 3 travellers + bags" over three
  lines at the same time.

  Below 640px the row is a grid: the fare takes the top of the right-hand column and Select
  drops underneath it. Desktop keeps the side-by-side flex row — the owner asked for the
  mobile change ONLY, so the desktop arrangement is pinned here too.

  Assertions are relational (which box is above/inside which) rather than measured pixels:
  text width differs between macOS and Linux CI, and a spec pinned to px would flip red on
  the runner for reasons that have nothing to do with this bug.
*/

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 900 };

const ROUTE = 'from=cmb-airport&to=sigiriya&pax=1';

// Geometry of every vehicle row on the private card, plus the row's own content box.
const rowBoxes = (page) => page.locator('.opt-private .veh-row').evaluateAll((rows) =>
  rows.map((row) => {
    const cs = getComputedStyle(row);
    const box = row.getBoundingClientRect();
    const rect = (sel) => {
      const el = row.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const amt = row.querySelector('.amt');
    return {
      price: rect('.v-price'),
      btn: rect('.btn'),
      amtSpill: amt.scrollWidth - amt.clientWidth,
      amtLines: amt.getClientRects().length,
      innerRight: box.right - parseFloat(cs.paddingRight),
      innerLeft: box.left + parseFloat(cs.paddingLeft),
    };
  }));

test('mobile: the fare sits above its Select button, and neither overruns the row', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await gotoBooking(page, { path: '/search.html', query: ROUTE });
  await expect(page.locator('.opt-private .veh-row').first()).toBeVisible();

  const rows = await rowBoxes(page);
  expect(rows.length, 'expected both the car and the van row').toBe(2);

  for (const [i, r] of rows.entries()) {
    expect(r.btn, `row ${i} has no Select button`).not.toBeNull();
    // The whole point of the mobile layout: Select is BELOW the fare, not beside it.
    expect(r.btn.top, `row ${i}: Select is not below the fare`).toBeGreaterThanOrEqual(r.price.bottom - 1);
    // …and the two no longer share a horizontal band, which is how the overlap happened.
    expect(r.price.bottom, `row ${i}: the fare still overlaps Select`).toBeLessThanOrEqual(r.btn.top + 1);
    // Both stay inside the row's padding — the clipped-button symptom.
    expect(r.btn.right, `row ${i}: Select runs past the row`).toBeLessThanOrEqual(r.innerRight + 1);
    expect(r.price.right, `row ${i}: the fare runs past the row`).toBeLessThanOrEqual(r.innerRight + 1);
    // A "fix" that stops the overlap by wrapping the money instead is not a fixed price.
    expect(r.amtSpill, `row ${i}: the fare text is wider than its box`).toBeLessThanOrEqual(1);
    expect(r.amtLines, `row ${i}: the fare wrapped onto more than one line`).toBe(1);
  }
});

test('desktop keeps the fare and Select side by side', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoBooking(page, { path: '/search.html', query: ROUTE });
  await expect(page.locator('.opt-private .veh-row').first()).toBeVisible();

  const rows = await rowBoxes(page);
  for (const [i, r] of rows.entries()) {
    expect(r.btn.left, `row ${i}: Select left its desktop place beside the fare`)
      .toBeGreaterThanOrEqual(r.price.right - 1);
    expect(r.btn.top, `row ${i}: Select dropped below the fare on desktop`)
      .toBeLessThan(r.price.bottom);
  }
});
