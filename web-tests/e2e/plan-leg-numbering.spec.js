import { test, expect } from '@playwright/test';

/* Both planner views numbered their cards by array index, so an itinerary that carries stays read
   "Leg 1 · Stay 2 · Leg 3 · Stay 4 · Leg 5" — there is no Leg 2, and "Leg 3" is the second
   transfer. Booking's own review counts legs properly (booking.js: ++_legNo), so the two screens
   disagreed about a trip the customer is about to pay for. Legs and stays each count from 1 in
   their own sequence. plan.js: legBadges. */

import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// Colombo Airport → Sigiriya (2 nights) → Kandy (1 night) → Ella:
// Leg 1 · Stay 1 · Leg 2 · Stay 2 · Leg 3
const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy|Ella';
const NIGHTS = '0,2,1,0';
const EXPECTED = ['Leg 1', 'Stay 1', 'Leg 2', 'Stay 2', 'Leg 3'];

const planUrl = (extra = '') =>
  `/plan.html?stops=${encodeURIComponent(STOPS)}&nights=${NIGHTS}&pax=2&vehicle=car${extra}`;

test('the route board numbers legs and stays in their own sequences', async ({ page }) => {
  await page.goto(planUrl());
  await expect(page.locator('#rail .leg-card')).toHaveCount(5);
  await expect(page.locator('#rail .leg-badge')).toHaveText(EXPECTED);
});

test('the dates step numbers them the same way', async ({ page }) => {
  await page.goto(planUrl('&step=dates'));
  await expect(page.locator('#dates-list .date-row')).toHaveCount(5);
  await expect(page.locator('#dates-list .dr-badge')).toHaveText(EXPECTED);
});

test('the planner and booking agree on what Leg 2 is', async ({ page }) => {
  await page.goto(planUrl('&step=dates'));
  // The planner's second transfer.
  await expect(
    page.locator('#dates-list .date-row', { has: page.locator('.dr-badge', { hasText: 'Leg 2' }) })
      .locator('.dr-route'),
  ).toContainText('Sigiriya');

  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  // Booking's review of the same transfer, under the same number.
  await expect(
    page.locator('.tr-leg', { has: page.locator('.tr-leg-badge', { hasText: 'Leg 2' }) })
      .locator('.tr-leg-title'),
  ).toContainText('Sigiriya');
});

test('a route with no stays is unaffected', async ({ page }) => {
  await page.goto(`/plan.html?stops=${encodeURIComponent(STOPS)}&pax=2&vehicle=car&step=dates`);
  await expect(page.locator('#dates-list .dr-badge')).toHaveText(['Leg 1', 'Leg 2', 'Leg 3']);
});
