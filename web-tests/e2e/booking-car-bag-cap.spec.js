import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Owner, 2026-10-27: an AC car takes 2 large bags, not 3. The booking page used to allow a third
// ("AC car (up to 3) · up to 3 bags", "That's the max for an AC car" only at 3), while the planner
// and search already advertised 2. The engine now sizes a 3-bag car request up to a van
// (rateCard car maxBags 2), so the bag step has to stop the car at 2 and offer the van at 3.

const CAR = 6700;
const VAN = 8999;
// what the live engine does: over 2 bags (or 3 travellers) it prices a van whatever was asked for
const engine = (intent) => ({ totalCents: intent.vehicle === 'van' || intent.pax > 3 || intent.bags > 2 ? VAN : CAR });

test('a car takes 2 large bags; the third offers the van', async ({ page }) => {
  await gotoBooking(page, { estimate: { respond: engine } });
  await page.evaluate(() => window.goStep && window.goStep(3));

  await expect(page.locator('#bag-cap')).toHaveText('AC car (up to 3) · up to 2 bags');
  await expect(page.locator('#bg-n')).toHaveText('2');
  await expect(page.locator('#cap-note')).toContainText('That’s the max for an AC car');

  await page.click('#bg-up');
  await expect(page.locator('#bg-n')).toHaveText('3');
  const note = page.locator('#cap-note');
  await expect(note).toContainText('3 large bags won’t fit an AC car (up to 2)');
  await expect(note.locator('.cap-switch')).toBeVisible();
  await expect(page.locator('#n4')).toBeDisabled();
});
