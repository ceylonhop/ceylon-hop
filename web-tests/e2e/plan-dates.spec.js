import { test, expect } from '@playwright/test';

// The planner's "Add your dates" step used to silently reorder the legs into
// chronological order when a customer typed an out-of-order date. It now keeps
// the route as the customer built it and *flags* the offending leg instead
// (mirroring the ops quote tool's "Dates out of order" flag). plan.js:outOfOrderFlags.

const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy'; // -> Leg 1: CMB→Sigiriya, Leg 2: Sigiriya→Kandy

// The per-leg date input is turned into a hidden field by the custom datepicker,
// so drive it the way the app does: set the value and fire the change event.
async function setLegDate(page, legIndex, iso) {
  await page.$eval(
    `.date-row[data-i="${legIndex}"] input`,
    (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); },
    iso,
  );
  await page.waitForTimeout(150);
}

test('out-of-order leg dates raise a flag and never reorder the itinerary', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}`);

  const rows = page.locator('#dates-list .date-row');
  await expect(rows).toHaveCount(2);
  const warn = page.locator('.dr-warn');

  // In chronological order → no flag.
  await setLegDate(page, 0, '2026-08-10');
  await setLegDate(page, 1, '2026-08-20');
  await expect(warn).toHaveCount(0);

  // Date Leg 2 BEFORE Leg 1. Old behaviour: Leg 2 slides above Leg 1.
  // New behaviour: order is preserved and Leg 2 is flagged.
  await setLegDate(page, 1, '2026-08-05');
  await expect(warn).toHaveCount(1);
  await expect(warn).toBeVisible();
  await expect(warn).toContainText(/out of order/i);

  // The itinerary did NOT reorder: Leg 1 is still first (CMB→Sigiriya),
  // and the flag sits on the second row (Sigiriya→Kandy).
  await expect(rows.first().locator('.dr-route')).toContainText('Colombo');
  await expect(rows.nth(1).locator('.dr-route')).toContainText('Kandy');
  await expect(page.locator('.date-row[data-i="1"] .dr-warn')).toBeVisible();

  // Fix the date so the trip runs forward again → flag clears.
  await setLegDate(page, 1, '2026-08-25');
  await expect(warn).toHaveCount(0);
});

test('an out-of-order date blocks "Continue to booking" until it is fixed', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto(`/plan.html?step=dates&stops=${encodeURIComponent(STOPS)}`);

  const cont = page.locator('#dates-continue');
  const hint = page.locator('#dates-order-hint');

  // Put the legs out of chronological order.
  await setLegDate(page, 0, '2026-08-10');
  await setLegDate(page, 1, '2026-08-05');

  // CTA is disabled + a blocking hint shows, and clicking does NOT leave plan.html.
  await expect(cont).toHaveClass(/cta-disabled/);
  await expect(cont).toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toBeVisible();
  await cont.click({ force: true }); // force past the cookie banner; the gate is in the handler
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/plan\.html/);

  // Fix the order → CTA re-enables and now proceeds to booking.
  await setLegDate(page, 1, '2026-08-20');
  await expect(cont).not.toHaveClass(/cta-disabled/);
  await expect(hint).toBeHidden();
  await cont.click({ force: true });
  await expect(page).toHaveURL(/booking\.html/);
});
