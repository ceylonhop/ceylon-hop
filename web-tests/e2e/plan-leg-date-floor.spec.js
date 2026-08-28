import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// Friend-reported 2026-08-27 (screenshot): leg 2 of a trip was dated three days BEFORE leg 1, and
// all the planner did was flag it after the fact — "Dates out of order", Continue disabled, fix it
// yourself. Their note: "instead can make any past dates not selectable".
//
// The ops quote tool already works that way: legDateFloor (ops-ui.html, shipped 2026-07-26) chains
// each leg's `min` off the leg above, "which also stops a later leg being dated before an earlier
// one, previously only a warning in the flags card" (ops-leg-date-floor.spec.js). The customer
// planner was the one place still only warning. This closes that gap.
//
// The warning is NOT removed — a date set before the floor existed (a ?dates= deep link, a route
// reordered after the fact) still has to be caught, and plan-dates.spec.js still pins it.

const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy'; // Leg 1: CMB→Sigiriya, Leg 2: Sigiriya→Kandy

// A floor date comfortably inside its month, so "the day before" is in the same month grid and a
// disabled cell is actually visible. Derived from today, never hard-coded (dates.js).
function floorDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  while (d.getDate() < 10 || d.getDate() > 25) d.setDate(d.getDate() + 1);
  return d;
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});

async function setLegDate(page, legIndex, value) {
  await page.$eval(
    `.date-row[data-i="${legIndex}"] input`,
    (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); },
    value,
  );
  await page.waitForTimeout(150);
}

test('a later leg cannot be dated before an earlier one', async ({ page }) => {
  const FLOOR = floorDate();
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}&pax=2`);
  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);

  await setLegDate(page, 0, iso(FLOOR));

  // The contract that drives the calendar: leg 2 may not be dated before leg 1.
  await expect(page.locator('.date-row[data-i="1"] input')).toHaveAttribute('min', iso(FLOOR));

  // And in the calendar itself: the floor is pickable, the day before it is not.
  await page.locator('.date-row[data-i="1"] .dp-btn').click();
  const pop = page.locator('.dp-pop:not([hidden])');
  await expect(pop).toBeVisible();

  // It opens on the floor's month rather than on a month with nothing selectable in it.
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  await expect(pop.locator('.dp-head b')).toHaveText(`${MONTHS[FLOOR.getMonth()]} ${FLOOR.getFullYear()}`);

  const day = (n) => pop.locator('.dp-day', { hasText: new RegExp(`^${n}$`) }).first();
  await expect(day(FLOOR.getDate())).toBeEnabled();          // same day as leg 1 is allowed
  await expect(day(FLOOR.getDate() - 1)).toBeDisabled();     // the day before it is not
});

test('leg 1 keeps the ordinary floor, and the flag still guards what the picker cannot', async ({ page }) => {
  const FLOOR = floorDate();
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}&pax=2`);

  // Nothing is dated above leg 1, so it keeps the datepicker's own floor of tomorrow.
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  await expect(page.locator('.date-row[data-i="0"] input')).toHaveAttribute('min', iso(tomorrow));

  // A date set straight into state (a ?dates= deep link, or a route reordered after dating) can
  // still be out of order — the picker never saw it. The warning has to stay.
  await setLegDate(page, 0, iso(FLOOR));
  const before = new Date(FLOOR); before.setDate(before.getDate() - 3);
  await setLegDate(page, 1, iso(before));
  await expect(page.locator('.dr-warn')).toHaveCount(1);
  await expect(page.locator('#dates-continue')).toHaveClass(/cta-disabled/);
});
