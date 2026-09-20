import { test, expect } from '@playwright/test';

/* Asking for eight dates when the customer holds one. An itinerary that carries nights already
   says how long each stop lasts, so the dates follow from a single answer: when does the trip
   start? The WHEN step now asks that once and reads the rest off the nights, instead of putting
   a separate calendar in front of every leg. plan.js: cascadeFrom / canCascade.

   Owner decisions (2026-09-15):
   - editing a leg by hand re-anchors everything AFTER it; legs above stay put
   - a route with no nights has nothing to cascade from, so the anchor is hidden there rather
     than shown under-delivering (buildLegs only creates stay legs when the route has nights) */

import { futureIsoDate } from '../dates.js';
import { blockLiveApi } from './_stubs.js';

test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// Colombo Airport → Sigiriya (2 nights) → Kandy (1 night) → Ella, i.e.
// Leg 1 · Stay 1 (2n) · Leg 2 · Stay 2 (1n) · Leg 3
const STOPS = 'Colombo Airport (CMB)|Sigiriya|Kandy|Ella';
const NIGHTS = '0,2,1,0';
const START = futureIsoDate(30);

function plusDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The datepicker turns each input into a hidden field, so drive it the way the app does.
async function setDate(page, selector, iso) {
  await page.$eval(
    selector,
    (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); },
    iso,
  );
  await page.waitForTimeout(150);
}

async function openStep(page, { stops = STOPS, nights = NIGHTS } = {}) {
  const q = new URLSearchParams({ stops, pax: '2', vehicle: 'car' });
  if (nights) q.set('nights', nights);
  await page.goto(`/plan.html?${q.toString()}`);
  await page.locator('#request-btn').click();
  await expect(page.locator('#dates-wrap')).toBeVisible();
  await page.locator('#fork-known').click();
}

test('one start date dates the whole itinerary from the nights already planned', async ({ page }) => {
  await openStep(page);

  await expect(page.locator('#trip-start')).toBeVisible();
  const rows = page.locator('#dates-list .date-row');
  await expect(rows).toHaveCount(5);

  await setDate(page, '#trip-start input', START);

  // Leg 1 on the start day; 2 nights in Sigiriya, so Leg 2 is +2; 1 night in Kandy, so Leg 3 is +3.
  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue(START);
  await expect(page.locator('.date-row[data-i="1"] input')).toHaveValue(START);
  await expect(page.locator('.date-row[data-i="2"] input')).toHaveValue(plusDays(START, 2));
  await expect(page.locator('.date-row[data-i="3"] input')).toHaveValue(plusDays(START, 2));
  await expect(page.locator('.date-row[data-i="4"] input')).toHaveValue(plusDays(START, 3));

  // A cascaded date says where it came from, so nobody thinks they typed it.
  await expect(page.locator('.date-row[data-i="2"] .dr-tag')).toContainText(/start date/i);
});

test('editing a leg by hand moves the legs after it, and leaves the ones above alone', async ({ page }) => {
  await openStep(page);
  await setDate(page, '#trip-start input', START);

  // Push Leg 2 a day later than the cascade put it.
  const moved = plusDays(START, 3);
  await setDate(page, '.date-row[data-i="2"] input', moved);

  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue(START);          // above: unmoved
  await expect(page.locator('.date-row[data-i="1"] input')).toHaveValue(START);          // above: unmoved
  await expect(page.locator('.date-row[data-i="2"] input')).toHaveValue(moved);
  await expect(page.locator('.date-row[data-i="3"] input')).toHaveValue(moved);          // below: follows
  await expect(page.locator('.date-row[data-i="4"] input')).toHaveValue(plusDays(moved, 1));

  await expect(page.locator('.date-row[data-i="2"] .dr-tag')).toContainText(/edited/i);
});

test('a hand-set leg keeps its date when the start date moves', async ({ page }) => {
  await openStep(page);
  await setDate(page, '#trip-start input', START);

  const pinned = plusDays(START, 9);
  await setDate(page, '.date-row[data-i="4"] input', pinned);

  // Re-anchor the trip a day later: cascaded legs shift, the pinned one does not.
  const newStart = plusDays(START, 1);
  await setDate(page, '#trip-start input', newStart);

  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue(newStart);
  await expect(page.locator('.date-row[data-i="2"] input')).toHaveValue(plusDays(newStart, 2));
  await expect(page.locator('.date-row[data-i="4"] input')).toHaveValue(pinned);
});

test('a leg made flexible stays blank and lets the cascade pass through it', async ({ page }) => {
  await openStep(page);
  await setDate(page, '#trip-start input', START);

  await page.locator('.date-row[data-i="2"] .dr-clear').click();
  await expect(page.locator('.date-row[data-i="2"] input')).toHaveValue('');
  await expect(page.locator('.date-row[data-i="2"] .dr-clear')).toHaveCount(0);  // blank again
  await expect(page.locator('.date-row[data-i="2"] .dr-tag')).toHaveCount(0);    // and unattributed

  // The legs after it keep the dates the nights imply — one blank leg doesn't derail the trip.
  await expect(page.locator('.date-row[data-i="4"] input')).toHaveValue(plusDays(START, 3));
});

test('the cascade never produces out-of-order dates', async ({ page }) => {
  await openStep(page);
  await setDate(page, '#trip-start input', START);

  await expect(page.locator('#dates-list .dr-warn')).toHaveCount(0);
  await expect(page.locator('#dates-order-hint')).toBeHidden();
  await expect(page.locator('#dates-continue')).not.toHaveClass(/cta-disabled/);
});

test('a route with no nights hides the anchor and keeps the per-leg list', async ({ page }) => {
  // buildLegs only creates stay legs when the route carries nights, so there is nothing to
  // cascade from — the anchor would be a promise the page cannot keep.
  await openStep(page, { stops: 'Colombo Airport (CMB)|Sigiriya|Kandy', nights: '' });

  await expect(page.locator('#trip-start')).toBeHidden();
  await expect(page.locator('#dates-list .date-row')).toHaveCount(2);
  // Just the ordinary per-leg date field, undated and unannotated.
  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue('');
  await expect(page.locator('.date-row[data-i="0"] .dr-tag')).toHaveCount(0);
});

test('with no nights, dating one leg leaves every other leg alone', async ({ page }) => {
  /* The bug this pins (shipped by the cascade, owner-spotted 2026-09-19): the re-cascade ran on
     every hand-set date, guarded by nothing. A transfer does not advance the running date, so on
     a route with no stays the cursor never moved and each later leg was stamped with the SAME
     day — three transfers on one date the customer never chose, sent on to booking. */
  await openStep(page, { stops: 'Negombo|Sigiriya|Kandy|Nuwara Eliya', nights: '' });
  await expect(page.locator('#dates-list .date-row')).toHaveCount(3);

  await setDate(page, '.date-row[data-i="0"] input', START);

  await expect(page.locator('.date-row[data-i="0"] input')).toHaveValue(START);
  await expect(page.locator('.date-row[data-i="1"] input')).toHaveValue('');
  await expect(page.locator('.date-row[data-i="2"] input')).toHaveValue('');

  // A second leg is likewise its own: dating leg 2 must not disturb leg 3 either.
  await setDate(page, '.date-row[data-i="1"] input', plusDays(START, 4));
  await expect(page.locator('.date-row[data-i="2"] input')).toHaveValue('');

  // ...and only the dates the customer actually set reach booking.
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  const dates = (new URL(page.url()).searchParams.get('dates') || '').split(',');
  expect(dates).toEqual([START, plusDays(START, 4), '']);
});

test('cascaded dates reach booking as the real per-leg dates', async ({ page }) => {
  await openStep(page);
  await setDate(page, '#trip-start input', START);
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  // One date per wire, in order, exactly as the cascade laid them out.
  const dates = (new URL(page.url()).searchParams.get('dates') || '').split(',');
  expect(dates[0]).toBe(START);
  expect(dates[1]).toBe(plusDays(START, 2));
  expect(dates[2]).toBe(plusDays(START, 3));
});
