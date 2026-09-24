import { test, expect } from '@playwright/test';

// Clarity, 21–22 Sep 2026: "goBook is not defined" in 2 sessions. The homepage search form's
// only way to search was onsubmit="return goBook(event)", and goBook is assigned at the END of
// the page's main inline script — after seven scripts at the bottom of the body and ~350 lines
// of decorative setup. Tap Search before that has run (slow phone network), or after anything
// above it has thrown (a blocked data file, an in-app browser), and the handler throws: the form
// has no action, so the page reloads and the traveller's search is lost.
//
// The form now degrades to a plain GET to search.html, which prices places by NAME as well as
// by id (search.js "params"). goBook still runs whenever it is there.

async function searchWithoutTheMainScript(page) {
  // site.js never arriving is the same failure as the main script throwing before goBook:
  // the inline script calls initChrome() on its first line and stops.
  await page.route('**/site.js*', (r) => r.abort());
  await page.goto('/index.html');
  await page.locator('#q-from').fill('Kandy');
  await page.locator('#q-to').fill('Ella');
  await page.locator('#go-btn').click();
}

test('Search still searches when the page script never ran', async ({ page }) => {
  await searchWithoutTheMainScript(page);
  await expect(page).toHaveURL(/\/search\.html\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('from')).toBe('Kandy');
  expect(url.searchParams.get('to')).toBe('Ella');
});

test('with the script loaded, Search is unchanged: known places travel as their ids', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.goBook === 'function');
  await page.locator('#q-from').fill('Kandy');
  await page.locator('#q-to').fill('Ella');
  await page.keyboard.press('Escape');
  await page.locator('#go-btn').click();
  await expect(page).toHaveURL(/\/search\.html\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('from')).toBe('kandy');
  expect(url.searchParams.get('to')).toBe('ella');
});
