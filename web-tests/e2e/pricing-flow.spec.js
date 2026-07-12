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

test('firm floor: a cheaper new drop-off never drops the quoted price', async ({ page }) => {
  // legPrice(200,'car') = round(220 × 0.35) = $77, which is LESS than the quoted $121.
  // The quote is a firm floor, so it must HOLD at $121 (no drop, no heads-up needed).
  // Pin the pick inside the Hikkaduwa drop-off area so the 10 km guard is satisfied
  // and we exercise the re-price path (not the out-of-area block).
  await gotoBooking(page, { routeKm: 200, pickGeo: { lat: 6.15, lng: 80.11 } });
  await expect(page.locator('#sum-total')).toHaveText('$121');

  // Known places are intentionally listed before Google. Pick the Google row
  // explicitly so this test continues to exercise live-distance repricing.
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  await expect(page.locator('#sum-name')).toContainText('Hikkaduwa hotel Result 1'); // drop-off did change
  await expect(page.locator('#reprice-note')).toHaveCount(0);                // but no notice (cheaper)
  await expect(page.locator('#sum-total')).toHaveText('$121');               // firm floor held
});

test('warns before a material price increase and holds the total until accepted', async ({ page }) => {
  // Stub reports a 400 km route. On load (no pick) the price must hold at the quoted $121.
  await gotoBooking(page, { routeKm: 400, pickGeo: { lat: 6.15, lng: 80.11 } });
  await expect(page.locator('#sum-total')).toHaveText('$121');

  // Customer picks a drop-off inside the area whose routed distance drifts up materially.
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);

  // Heads-up appears; total is NOT changed yet; Continue is gated.
  await expect(page.locator('#reprice-note')).toBeVisible();
  await expect(page.locator('#sum-total')).toHaveText('$121');
  await expect(page.locator('#n1')).toBeDisabled();

  // Accept the higher fixed price. legPrice(400,'car') = round(440×0.4025) = $177.
  await page.locator('#reprice-note button.btn-primary').click();
  await expect(page.locator('#sum-total')).toHaveText('$177');
  await expect(page.locator('#reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

test('switching vehicle while a drift notice is pending keeps the hold (no early jump to the drifted price)', async ({ page }) => {
  // Regression guard for the reprice acknowledgement (PR #21). While a notice is pending
  // the total must HOLD at the selected vehicle's un-drifted price and only move to the
  // drifted price on accept. Switching car→van mid-notice must preserve that invariant:
  // total shows the van's standard $85 (privateQuote), NOT the drifted legPrice(400,'van')=$238,
  // and the notice reads "from $85 to $238". (A naive "unit = pendingReprice.prices[key]"
  // would show $238 before acknowledgement and render a broken "from $238 to $238" line.)
  await gotoBooking(page, { routeKm: 400, pickGeo: { lat: 6.15, lng: 80.11 } });

  // Car drift notice appears: from the quoted $121 to legPrice(400,'car')=$177. Total held, gated.
  await pickPlace(page, '#loc-to', 'ac-to', 'Hikkaduwa hotel', 1);
  await expect(page.locator('#reprice-note')).toBeVisible();
  await expect(page.locator('#reprice-note')).toContainText('$121');
  await expect(page.locator('#reprice-note')).toContainText('$177');
  await expect(page.locator('#sum-total')).toHaveText('$121');
  await expect(page.locator('#n1')).toBeDisabled();

  // Switch to the van WHILE the notice is still pending.
  await page.evaluate(() => window.switchToVan());

  // The total holds at the van's un-drifted standard price ($85) — it must NOT jump to $238 yet.
  await expect(page.locator('#sum-total')).toHaveText('$85');
  // Notice now offers the van's own drift: from $85 (standard) to $238 (legPrice(400,'van')).
  await expect(page.locator('#reprice-note')).toContainText('$85');
  await expect(page.locator('#reprice-note')).toContainText('$238');
  await expect(page.locator('#n1')).toBeDisabled();

  // Accepting commits the drifted van price and clears the gate.
  await page.locator('#reprice-note button.btn-primary').click();
  await expect(page.locator('#sum-total')).toHaveText('$238');
  await expect(page.locator('#reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});

test('step 2 shows the settled areas as done chips and invites the exact spot', async ({ page }) => {
  await gotoBooking(page); // default private route (cmb-airport → hikkaduwa)
  await expect(page.locator('#s1-title')).toHaveText('Add your exact pick-up & drop-off');
  // The homepage-chosen areas are closed/done — chips, not editable input values.
  await expect(page.locator('#loc-area-from b')).toHaveText('Colombo Airport (CMB)');
  await expect(page.locator('#loc-area-to b')).toHaveText('Hikkaduwa');
  await expect(page.locator('#loc-from')).toHaveValue('');
  await expect(page.locator('#loc-to')).toHaveValue('');
  await expect(page.locator('#loc-from')).toHaveAttribute('placeholder', 'Hotel or address (optional)');
  // Continue is not gated on the exact spot — the settled area is a valid answer.
  await expect(page.locator('#n1')).toBeEnabled();
});

test('decide later collapses the exact-spot input and keeps the original price', async ({ page }) => {
  await gotoBooking(page, { routeKm: 400 }); // even with a long stubbed route: no pick → no reprice
  await page.evaluate(() => window.goStep && window.goStep(2)); // the WHERE panel
  const before = await page.locator('#sum-total').textContent();
  await page.locator('#loc-later-from').click();
  await expect(page.locator('#loc-note-from')).toBeVisible();  // friendly note in its place
  await expect(page.locator('#loc-from')).toBeHidden();        // input tucked away
  await expect(page.locator('#reprice-note')).toHaveCount(0);  // no price movement
  await expect(page.locator('#sum-total')).toHaveText(before);
  await expect(page.locator('#n1')).toBeEnabled();
  // Undo brings the input back, ready to type.
  await page.locator('#loc-undo-from').click();
  await expect(page.locator('#loc-from')).toBeVisible();
  await expect(page.locator('#loc-from')).toBeFocused();
});

test('an exact spot outside its area is blocked, not repriced', async ({ page }) => {
  await gotoBooking(page); // cmb-airport → hikkaduwa; the pick-up area is Colombo Airport
  await page.evaluate(() => window.goStep && window.goStep(2));
  const before = await page.locator('#sum-total').textContent();

  // Jaffna is ~276 km from the airport — a different route, not an exact spot.
  // (Resolves from the known-place list, so no Google needed in the harness.)
  await page.fill('#loc-from', 'Jaffna');

  const note = page.locator('#reprice-note.reprice-block');
  await expect(note).toBeVisible();
  await expect(note).toContainText('outside your pick-up area');
  await expect(note).toContainText('within 10 km');
  await expect(note).not.toContainText('Got it — use');  // NOT the accept-and-continue reprice
  await expect(page.locator('#n1')).toBeDisabled();       // Continue is hard-blocked
  await expect(page.locator('#sum-total')).toHaveText(before); // price never moved

  // "Clear this spot" recovers: back to the settled area, Continue re-enabled.
  await note.locator('button', { hasText: 'Clear this spot' }).click();
  await expect(page.locator('#reprice-note')).toHaveCount(0);
  await expect(page.locator('#loc-from')).toHaveValue('');
  await expect(page.locator('#n1')).toBeEnabled();
});
