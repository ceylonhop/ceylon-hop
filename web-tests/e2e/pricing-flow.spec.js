import { test, expect } from '@playwright/test';
import { gotoBooking, pickPlace } from './_stubs.js';

test('price holds at the quoted amount on load (no re-price from the pre-filled route)', async ({ page }) => {
  // Stubbed route reports 200km, but an unchanged pre-filled route must NOT re-price.
  await gotoBooking(page, { routeKm: 200 });
  await expect(page.locator('#sum-total')).toHaveText('$121');
  // give the map/onRoute a moment — price must still hold (regression: b528abc)
  await page.waitForTimeout(1200);
  await expect(page.locator('#sum-total')).toHaveText('$121');
});

test('re-prices from real distance after the customer picks a new drop-off', async ({ page }) => {
  // legPrice(200,'car') = max(29, round(round(200×1.10) × 0.46)) = round(220 × 0.46) = $101
  await gotoBooking(page, { routeKm: 200 });
  await expect(page.locator('#sum-total')).toHaveText('$121');

  await pickPlace(page, '#loc-to', 'ac-to', 'Jaffna');

  await expect(page.locator('#sum-total')).toHaveText('$101');
  await expect(page.locator('#sum-name')).toContainText('Jaffna Result 1');
});

test('warns before a material price increase and holds the total until accepted', async ({ page }) => {
  // Stub reports a 400 km route. On load (no pick) the price must hold at the quoted $121.
  await gotoBooking(page, { routeKm: 400 });
  await expect(page.locator('#sum-total')).toHaveText('$121');

  // Customer picks a far-off drop-off → material upward drift.
  await pickPlace(page, '#loc-to', 'ac-to', 'Jaffna');

  // Heads-up appears; total is NOT changed yet; Continue is gated.
  await expect(page.locator('#reprice-note')).toBeVisible();
  await expect(page.locator('#sum-total')).toHaveText('$121');
  await expect(page.locator('#n1')).toBeDisabled();

  // Accept the higher fixed price. legPrice(400,'car') = round(440×0.46) = $202.
  await page.locator('#reprice-note button.btn-primary').click();
  await expect(page.locator('#sum-total')).toHaveText('$202');
  await expect(page.locator('#reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

test('switching vehicle while a drift notice is pending keeps the hold (no early jump to the drifted price)', async ({ page }) => {
  // Regression guard for the reprice acknowledgement (PR #21). While a notice is pending
  // the total must HOLD at the selected vehicle's un-drifted price and only move to the
  // drifted price on accept. Switching car→van mid-notice must preserve that invariant:
  // total shows the van's standard $131 (privateQuote), NOT the drifted legPrice(400,'van')=$365,
  // and the notice reads "from $131 to $365". (A naive "unit = pendingReprice.prices[key]"
  // would show $365 before acknowledgement and render a broken "from $365 to $365" line.)
  await gotoBooking(page, { routeKm: 400 });

  // Car drift notice appears: from the quoted $121 to legPrice(400,'car')=$202. Total held, gated.
  await pickPlace(page, '#loc-to', 'ac-to', 'Jaffna');
  await expect(page.locator('#reprice-note')).toBeVisible();
  await expect(page.locator('#reprice-note')).toContainText('$121');
  await expect(page.locator('#reprice-note')).toContainText('$202');
  await expect(page.locator('#sum-total')).toHaveText('$121');
  await expect(page.locator('#n1')).toBeDisabled();

  // Switch to the van WHILE the notice is still pending.
  await page.evaluate(() => window.switchToVan());

  // The total holds at the van's un-drifted standard price ($131) — it must NOT jump to $365 yet.
  await expect(page.locator('#sum-total')).toHaveText('$131');
  // Notice now offers the van's own drift: from $131 (standard) to $365 (legPrice(400,'van')).
  await expect(page.locator('#reprice-note')).toContainText('$131');
  await expect(page.locator('#reprice-note')).toContainText('$365');
  await expect(page.locator('#n1')).toBeDisabled();

  // Accepting commits the drifted van price and clears the gate.
  await page.locator('#reprice-note button.btn-primary').click();
  await expect(page.locator('#sum-total')).toHaveText('$365');
  await expect(page.locator('#reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

test('step 2 invites an exact hotel / pick-up location', async ({ page }) => {
  await gotoBooking(page); // default private route (cmb-airport → hikkaduwa)
  await expect(page.locator('#s1-title')).toHaveText('Add your exact pick-up & drop-off');
  await expect(page.locator('#loc-from')).toHaveAttribute('placeholder', 'Add your hotel, address or landmark…');
  await expect(page.locator('#loc-to')).toHaveAttribute('placeholder', 'Add your hotel, address or landmark…');
});
