import { test, expect } from '@playwright/test';
import { gotoBooking, blockLiveApi, installStubs } from './_stubs.js';

/*
  A customer who builds a quote and then taps WhatsApp used to arrive in the inbox saying
  nothing — ops had to ask the route, the date and the party size back before they could
  answer. quote.html has prefilled its CTAs since 2026-08-07 and search.js does the same for
  its route cards; booking.html's two and plan.html's one were the ones still bare.

  These assert the DRAFT, not the send: WhatsApp shows the customer the message before it
  goes, and nothing leaves the page unless they press send.
*/

const textOf = (href) => decodeURIComponent(new URL(href).searchParams.get('text') || '');

test('the booking summary CTA carries the trip, not an empty chat', async ({ page }) => {
  await gotoBooking(page);
  const href = await page.locator('#s-wa').getAttribute('href');
  expect(href, 'no href on the summary CTA').toBeTruthy();

  const msg = textOf(href);
  expect(msg).toContain('Ceylon Hop');
  // the route the customer is actually looking at
  expect(msg).toMatch(/→/);
  // party size and vehicle, so ops can answer without a round trip
  expect(msg).toMatch(/\d+ traveller/);
  expect(msg).toMatch(/AC (car|van)/);
  expect(msg).toMatch(/Private transfer|Shared seat|Chauffeur-guide/);
});

test('the draft follows the trip when the customer changes it', async ({ page }) => {
  await gotoBooking(page);
  const before = textOf(await page.locator('#s-wa').getAttribute('href'));

  /* Add a traveller. Driven through the page's own step() rather than the button, which lives
     on a later wizard panel and is not reachable from where gotoBooking lands — reaching it is
     navigation, which other specs already cover. What matters here is that a change to the
     trip repaints the draft. */
  await page.evaluate(() => step('ad', 1));
  await expect.poll(async () => textOf(await page.locator('#s-wa').getAttribute('href')))
    .not.toBe(before);

  const after = textOf(await page.locator('#s-wa').getAttribute('href'));
  expect(after).toMatch(/\d+ travellers/);
});

test('carries no personal details — the trip only', async ({ page }) => {
  await gotoBooking(page);
  const msg = textOf(await page.locator('#s-wa').getAttribute('href'));
  // identity comes with the WhatsApp account; the draft must never smuggle it
  expect(msg).not.toMatch(/@/);          // no email
  expect(msg).not.toMatch(/\+\d{6,}/);   // no phone number
});

test('the planner CTA carries the multi-stop itinerary', async ({ page }) => {
  await page.addInitScript(installStubs);
  await blockLiveApi(page);
  await page.goto('/plan.html?stops=Colombo|Kandy|Ella&pax=2&vehicle=car');

  const wa = page.locator('#sum-wa');
  await expect(wa).toHaveAttribute('href', /text=/);

  const msg = textOf(await wa.getAttribute('href'));
  expect(msg).toContain('Ceylon Hop');
  expect(msg).toMatch(/→/);            // the route is the whole question on this page
  expect(msg).toMatch(/\d+ traveller/);

  // #sum-dates already reads "Dates flexible · 2 travellers", so composing a party size on top
  // of it produced "2 travellers · 2 travellers". Caught by reading the drafted message rather
  // than by any assertion above — hence this one.
  expect(msg.match(/traveller/g) || []).toHaveLength(1);
});
