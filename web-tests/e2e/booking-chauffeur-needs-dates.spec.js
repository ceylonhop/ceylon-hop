import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

/* The chauffeur card can't be quoted until every leg has a date, so it renders inactive with the
   tag "Add all dates to quote" — the one thing that would unblock it. But the card is a <button>
   and it carried the `disabled` attribute, which makes everything inside it inert: the customer
   was told exactly what to do and given no way to do it (owner-spotted 2026-09-18).

   Missing dates are the customer's to fix, so the card now stays clickable and sends them to the
   planner's WHEN step. The notice window is different — no amount of dating fixes it today — so
   that state stays genuinely disabled and explains itself in the panel below the card. */

// An itinerary with no dates at all: CMB → Kandy (1 night) → Ella, two undated wires.
const NO_DATES_QUERY = [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
  'nights=0,1,0',
  'dates=,',
  'pax=2',
  'vehicle=car',
].join('&');

const card = (page) => page.locator('.svc[data-svc="chauffeur"]');

test('the undated chauffeur card offers the fix and can actually be pressed', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  await expect(page.locator('#svc-chooser')).toBeVisible();
  await expect(page.locator('#svc-chauffeur-tag')).toHaveText('Add all dates to quote');

  // Still reads as unavailable...
  await expect(card(page)).toHaveClass(/disabled/);
  // ...but is not inert: `disabled` would swallow every click inside it.
  await expect(card(page)).not.toBeDisabled();
});

test('pressing it lands on the planner step that collects the dates', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  await card(page).click();
  await page.waitForURL('**/plan.html?**');

  // The WHEN step, with the itinerary intact.
  expect(new URL(page.url()).searchParams.get('step')).toBe('dates');
  await expect(page.locator('#dates-wrap')).toBeVisible();
  await expect(page.locator('#dates-list .date-row')).toHaveCount(3); // Leg 1 · Stay 1 · Leg 2
});

test('pressing it never selects chauffeur, since it still cannot be quoted', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  await card(page).click();
  await page.waitForURL('**/plan.html?**');
  await page.goBack();

  // Private is still the chosen service — the press was a way out, not a selection.
  await expect(page.locator('.svc[data-svc="private"]')).toHaveClass(/on/);
  await expect(card(page)).not.toHaveClass(/\bon\b/);
});
