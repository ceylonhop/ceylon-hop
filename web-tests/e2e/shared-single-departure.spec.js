import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';
import { nextIsoWeekday, isoParts } from '../dates.js';

// A shared seat whose corridor runs ONE scheduled departure (Clarity, 2026-09-24, booking
// CH-V43ZU: Mirissa → Colombo Airport, south-airport, 14:45). The departure step used to show a
// read-only box styled like the dropdown it replaces, reading "2:45 pm · Morning hop" — the
// customer clicked it twice, nothing happened, and they left. The departure must arrive
// pre-selected, look selected, shrug off a click, and never be what blocks Continue.
// The unit twin (unit/booking-single-departure.test.js) covers the label and state rules;
// this is the real-browser journey with real clicks.
const QUERY = 'from=mirissa&to=cmb-airport&mode=shared&price=29.99&times=14%3A45&days=3%2C6&corridor=south-airport';

test('the single 14:45 departure reads as a selected Afternoon hop and a click on it is harmless', async ({ page }) => {
  await gotoBooking(page, { query: QUERY });

  const chip = page.locator('#single-dep-card');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/2:45 pm · Afternoon hop/);
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(chip).toHaveClass(/\bon\b/);
  await expect(page.locator('#sum-time')).toHaveText('2:45 pm');

  // Two real clicks, as in the recording: nothing breaks and nothing un-selects.
  await chip.click();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(chip).toHaveClass(/\bon\b/);
  await expect(page.locator('#sum-time')).toHaveText('2:45 pm');

  // It must not pose as a dropdown: no pointer cursor inviting a pick.
  expect(await chip.evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
});

test('Continue unlocks on the date alone — the departure never needs a click', async ({ page }) => {
  await gotoBooking(page, { query: QUERY });

  const cont = page.locator('#n2');
  await expect(cont).toBeDisabled();
  await expect(page.locator('#when-blocked')).toContainText('Pick a travel date');

  const { year, monthIndex, day } = isoParts(nextIsoWeekday(3)); // a Wednesday — a service day
  await page.evaluate(([y, m, d]) => window.pickDate(y, m, d), [year, monthIndex, day]);

  await expect(cont).toBeEnabled();
  await cont.click();
  await expect(page.locator('.panel.active')).toHaveAttribute('data-panel', '2');
});
