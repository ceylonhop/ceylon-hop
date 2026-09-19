import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Found in the 2026-09-18 pre-launch pass on prod (CMB → a Google-picked hotel, 4 adults + 1 child):
//
//     ⚠ 5 travellers won't fit an AC car (up to 3).   [ Switch to AC van ]
//     AC car (up to 3) .......... $67
//     Total ..................... $67
//     ⚠ Your price has been updated … your total is now $89.99 (it was $67).  [ Got it — use $89.99 ]
//
// Two controls for one decision. The engine upgrades the vehicle on its own once the party
// outgrows a car (pax "only upgrades the vehicle"), so the estimate for a CAR intent came back at
// the VAN price — and because nothing about product/vehicle/extras changed in the intent, the
// raise was parked as an undriven one. Pressing "Got it" first then printed
// "AC car (up to 3) — $89.99": the van's price on the car's label, with the red "won't fit"
// warning still up, and Continue still blocked.
//
// The capacity note already owns this decision (it blocks Continue until it is resolved), so it
// is the single control: it prints the engine's real van total on its button, the summary holds
// at the car figure the customer was shown, and no second notice appears. Pressing the switch IS
// the acknowledgement — the same rule customerDroveTheRaise applies to every other priced press.

const CAR = 6700;
const VAN = 8999;
// what the live engine does: over 3 travellers it prices a van whatever vehicle was asked for
const engine = (intent) => ({ totalCents: intent.vehicle === 'van' || intent.pax > 3 ? VAN : CAR });

const addAdult = (page) => page.click('#ad-step .ctrls button:has-text("+")');

test('outgrowing the car offers ONE control: the van switch, carrying the real price', async ({ page }) => {
  await gotoBooking(page, { estimate: { respond: engine } });
  await expect(page.locator('#sum-total')).toHaveText('$67');

  await page.evaluate(() => window.goStep && window.goStep(3));
  await addAdult(page); await addAdult(page); await addAdult(page); // 4 adults

  const note = page.locator('#cap-note');
  await expect(note).toContainText('won’t fit an AC car');
  // the switch names the engine's actual total — not the local formula's "~" guess, and not blank
  await expect(note.locator('.cap-switch')).toContainText('$89.99');

  // no second, competing notice; the summary holds at what they were shown, labelled as a car
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(page.locator('#sum-total')).toHaveText('$67');
  await expect(page.locator('#sum-adlabel')).toContainText('AC car');

  await note.locator('.cap-switch').click();

  // the press is the acknowledgement: van label, van price, nothing left to confirm
  await expect(page.locator('#sum-total')).toHaveText('$89.99');
  await expect(page.locator('#sum-adlabel')).toContainText('AC van');
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(note).not.toContainText('won’t fit');
  await expect(page.locator('#n4')).toBeEnabled();
});

test('shrinking the party back into the car clears the held upgrade', async ({ page }) => {
  await gotoBooking(page, { estimate: { respond: engine } });
  await page.evaluate(() => window.goStep && window.goStep(3));
  await addAdult(page); await addAdult(page); await addAdult(page);
  await expect(page.locator('#cap-note')).toContainText('won’t fit');

  await page.locator('#ad-step .ctrls button').first().click(); // the "–" stepper
  await expect(page.locator('#cap-note')).not.toContainText('won’t fit');
  await expect(page.locator('#sum-total')).toHaveText('$67');
  await expect(page.locator('#engine-reprice-note')).toHaveCount(0);
  await expect(page.locator('#n4')).toBeEnabled();
});
