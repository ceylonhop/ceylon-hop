import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

/* The chauffeur card can't be quoted until every leg has a date. It used to carry the `disabled`
   attribute, which makes everything inside it inert: the customer was told exactly what to do and
   given no way to do it (owner-spotted 2026-09-18). It then stayed pressable but still LOOKED off,
   faded with a tiny tag, and the only real button sat under every leg of the itinerary. People
   took it for unavailable and never scrolled to the button (owner, 2026-11-05).

   So missing dates now read as an offer: the card is at full strength with a real-looking button,
   and pressing it goes to the planner's WHEN step and comes back with chauffeur chosen. The notice
   window is different — adding dates doesn't fix it — so that state still reads as unavailable and
   explains itself beside the card. */

// An itinerary with no dates at all: CMB → Kandy (1 night) → Ella, two undated wires.
const tripQuery = (dates, extra = []) => [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
  'nights=0,1,0',
  `dates=${dates}`,
  'pax=2',
  'vehicle=car',
  ...extra,
].join('&');
const NO_DATES_QUERY = tripQuery(',');

const card = (page) => page.locator('.svc[data-svc="chauffeur"]');
const privateCard = (page) => page.locator('.svc[data-svc="private"]');

test('the undated chauffeur card reads as an offer, with a button, not as switched off', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  await expect(page.locator('#svc-chooser')).toBeVisible();
  await expect(page.locator('#svc-chauffeur-tag')).toHaveText('Add dates to see price');

  // Not faded...
  await expect(card(page)).not.toHaveClass(/disabled/);
  await expect(card(page)).toHaveCSS('opacity', '1');
  // ...not inert: `disabled` would swallow every click inside it...
  await expect(card(page)).not.toBeDisabled();
  // ...and the tag is a filled pill, not a text link.
  const tagBg = await page.locator('#svc-chauffeur-tag').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tagBg).not.toBe('rgba(0, 0, 0, 0)');

  // The card says it all, so the red "add your dates" block under the legs is gone.
  await expect(page.locator('#chauffeur-extra')).toBeHidden();
});

test('the button fits the card at every width', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  const measure = () => page.locator('#svc-chauffeur-tag').evaluate((tag) => {
    const t = tag.getBoundingClientRect();
    return { h: t.height, right: t.right, cardRight: tag.closest('.svc').getBoundingClientRect().right };
  });
  // The narrowest the card gets is just above the layout's two-column break, around 900px. It may
  // wrap there, but it must never spill out of the card.
  for (const width of [320, 375, 561, 700, 900, 1000, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const m = await measure();
    expect(m.right, `overflows the card at ${width}px`).toBeLessThanOrEqual(m.cardRight);
  }
  // One line on an ordinary phone and an ordinary laptop.
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect((await measure()).h, `wraps at ${width}px`).toBeLessThan(40);
  }
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

test('going back without adding dates leaves private chosen', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  await card(page).click();
  await page.waitForURL('**/plan.html?**');
  await page.goBack();

  // Private is still the chosen service — it still cannot be quoted.
  await expect(privateCard(page)).toHaveClass(/on/);
  await expect(card(page)).not.toHaveClass(/\bon\b/);
});

test('adding the dates comes back with chauffeur chosen', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  await card(page).click();
  await page.waitForURL('**/plan.html?**');
  // The custom datepicker hides the native input, so drive it the way the app does.
  const rows = page.locator('#dates-list .date-row[data-i]');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    await rows.nth(i).locator('input').evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, futureIsoDate(30 + i));
  }
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  await expect(card(page)).toHaveClass(/\bon\b/);
  await expect(privateCard(page)).not.toHaveClass(/\bon\b/);
  await expect(page.locator('#svc-chauffeur-tag')).toHaveText('Priced for the whole trip · pay in full');
  await expect(page.locator('#pvt-note-tx')).toContainText('One price covers the car, your driver-guide and every kilometre.');
});

test('coming back still undated stays on private and keeps offering the button', async ({ page }) => {
  await gotoBooking(page, { query: tripQuery(`${futureIsoDate(30)},`, ['svc=chauffeur']) });

  await expect(privateCard(page)).toHaveClass(/on/);
  await expect(page.locator('#svc-chauffeur-tag')).toHaveText('Add dates to see price');
  // Partly dated is still not quotable, and must not bounce them straight back to the planner.
  expect(new URL(page.url()).pathname).toBe('/booking.html');
});

test('coming back with dates inside the notice window explains it instead of selecting', async ({ page }) => {
  await gotoBooking(page, { query: tripQuery(`${futureIsoDate(3)},${futureIsoDate(5)}`, ['svc=chauffeur']) });

  await expect(privateCard(page)).toHaveClass(/on/);
  await expect(card(page)).toHaveClass(/disabled/);
  await expect(page.locator('#chauffeur-notice')).toBeVisible();
  await expect(page.locator('#chauffeur-notice')).toContainText('days’ notice');
});

test('coming back with a one-day trip has no chooser to select', async ({ page }) => {
  const day = futureIsoDate(30);
  const query = [
    'mode=trip',
    'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
    'nights=0,0,0',
    `dates=${day},${day}`,
    'pax=2',
    'vehicle=car',
    'svc=chauffeur',
  ].join('&');
  await gotoBooking(page, { query });

  await expect(page.locator('#svc-chooser')).toBeHidden();
  await expect(privateCard(page)).toHaveClass(/on/);
  await expect(card(page)).not.toHaveClass(/\bon\b/);
});

test('only the chauffeur press carries the choice; other ways back to the planner do not', async ({ page }) => {
  await gotoBooking(page, { query: NO_DATES_QUERY });

  await page.locator('.back-link', { hasText: 'Back to planner' }).first().click();
  await page.waitForURL('**/plan.html?**');
  expect(new URL(page.url()).searchParams.get('svc')).toBeNull();
});
