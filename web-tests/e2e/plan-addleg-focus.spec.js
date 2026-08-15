import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// plan.html pings the live API on load (0e0f077) — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// Adding a leg on the trip planner focuses the new leg's location field so the traveller
// can type the destination immediately. It must NOT auto-open the place-suggestion menu —
// that should appear only once they start typing.
//
// Why it would otherwise pop open: the add-stop/add-stay handlers .focus() the new (empty)
// field; wirePlaceSearch opens the menu on 'focus'; and placeSuggestions('') returns the
// popular places (transfers-data.js), so an empty focused field renders a full menu.

test('adding a leg focuses the new field but does not auto-open the place menu', async ({ page }) => {
  // Minimal Google Maps stub so plan.js's map/places wiring initialises offline.
  await page.addInitScript(() => {
    const places = {
      AutocompleteSessionToken: function () {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
    };
    const Route = {
      computeRoutes: async () => ({ routes: [{ legs: [{ distanceMeters: 100000, durationMillis: 5400000 }] }] }),
    };
    window.google = {
      maps: { importLibrary: async (n) => ({ routes: { Route }, places }[n] || {}), event: { trigger() {} } },
    };
  });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());

  // Seed one leg (two stops) so "Add stop" appends a second leg with the pickup pre-filled
  // and an empty drop-off — the exact case that focuses the new .leg-to field.
  await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo|Kandy') + '&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(1);

  await page.locator('#add-stop').click();
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);

  const lastTo = page.locator('#rail .leg-card').last().locator('.leg-to');
  // The new empty drop-off field is focused (ready to type)...
  await expect(lastTo).toBeFocused();
  // ...but the place-suggestion menu must NOT be open yet.
  await expect(page.locator('.place-menu')).toHaveCount(0);

  // Typing surfaces the menu on demand.
  await lastTo.pressSequentially('Ell', { delay: 20 });
  await expect(page.locator('.place-menu')).toHaveCount(1);
});

// The planner's menu is anchored to its field (plan.html: .place-menu{position:absolute}
// inside the field wrapper), so it travels with the page and a scroll can never leave it
// stranded. It must therefore survive a scroll it did not cause.
//
// It used to close on ANY scroll landing more than 250ms after it opened — a rule copied
// from site.js, where the menu is position:fixed and genuinely does come unstuck. With
// site.css's global html{scroll-behavior:smooth}, one programmatic scroll animates for
// several hundred ms and fires scroll events the whole way, so the grace window did not
// cover it: the menu vanished mid-selection and never came back. In CI that read as
// plan-dates.spec.js's "added planner legs and dates survive refresh" hanging on
// `.place-option` ("element was detached from the DOM, retrying") until the test timed out
// — only under parallel load, because only then is the smooth scroll still running when
// Playwright reaches for the option.
test('the place menu survives a scroll it did not cause, but a wheel gesture still dismisses it', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo|Kandy') + '&pax=2&vehicle=car');

  // Same starting point as the test above: a second leg with an empty, focused drop-off.
  await page.locator('#add-stop').click();
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);

  const menu = page.locator('.place-menu');
  await page.locator('#rail .leg-card').last().locator('.leg-to').pressSequentially('Ell', { delay: 20 });
  await expect(menu).toHaveCount(1);

  // Past the old 250ms grace window, then scroll the page the way a scrollIntoView (the
  // browser's, or Playwright's before a click) does — no wheel, no touch.
  // Resolve only once the scroll event has actually been dispatched — html{scroll-behavior:
  // smooth} makes even a 1px scroll land a frame or more later, and asserting ahead of it
  // would pass against the very bug this guards.
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('scroll', () => setTimeout(resolve, 0), { once: true });
    window.scrollBy(0, 1);
  }));
  await expect(menu).toHaveCount(1);
  await expect(page.locator('.place-option').first()).toBeVisible();

  // A deliberate wheel gesture is still "I'm moving on" and closes it.
  await page.mouse.wheel(0, 120);
  await expect(menu).toHaveCount(0);
});
