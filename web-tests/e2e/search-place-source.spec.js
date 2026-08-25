import { test, expect } from '@playwright/test';
import { gotoBooking, blockLiveApi } from './_stubs.js';

/*
  How often does a search arrive with a free-text place instead of a catalogue id?

  That number decides whether geo-matching a pin to a scheduled stop is worth building
  (2026-08-23) — and nothing could answer it. `search` already carries `from`/`to`, but
  GA4 only reports on a parameter registered as a custom dimension, `from`/`to` are not
  registered, and docs/analytics/ride-board-ga4-setup.md states the rule that makes this
  urgent: GA4 does NOT backfill, so an unregistered parameter is unqueryable for every day
  before it is registered.

  Registering `to` itself would be the wrong fix — it carries the raw place name, so every
  hotel and landmark a customer ever picks becomes a dimension value, and GA4 buckets past
  ~500 distinct daily values into "(other)".

  So this reports the SHAPE of the search, not the places: which ENDS arrived as free text.
  Four values, and the split matters — a free-text destination can be matched against the
  `PLACES` lat/lng we already ship (scheduled drop areas are >=28km apart), while a free-text
  origin needs boarding-point coordinates we don't store yet. "Which end" is the difference
  between a cheap fix and an expensive one.
*/

const UNKNOWN_TO = 'Sigiriya, Sri Lanka';   // the pick that started this (PR #560)
const UNKNOWN_FROM = 'pasikudah, Kalkudah, Sri Lanka';

const byVehicle = (intent) => ({
  totalCents: intent.vehicle === 'van' ? 21000 : 15500,
  legs: [{ from: intent.legs[0].from, to: intent.legs[0].to, distanceKm: 271, durationMin: 320 }],
});

// The `search` event fires on load for a baked pair and only after the estimate lands for an
// engine route, so both paths are polled the same way rather than assumed.
async function searchEvent(page) {
  await page.waitForFunction(
    () => (window.dataLayer || []).some((e) => e && e.event === 'search'),
    null,
    { timeout: 5000 },
  );
  return page.evaluate(
    () => (window.dataLayer || []).filter((e) => e && e.event === 'search').pop(),
  );
}

test('a catalogue pair reports no free-text end', async ({ page }) => {
  await blockLiveApi(page);
  await page.goto('/search.html?from=kandy&to=ella&pax=2');
  await page.waitForSelector('#results .opt');

  expect((await searchEvent(page)).freetext_place).toBe('none');
});

test('a Google-picked destination reports the destination end', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=cmb-airport&to=${encodeURIComponent(UNKNOWN_TO)}`,
    estimate: { respond: byVehicle },
  });

  expect((await searchEvent(page)).freetext_place).toBe('to');
});

test('a Google-picked origin reports the origin end', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=${encodeURIComponent(UNKNOWN_FROM)}&to=ella`,
    estimate: { respond: byVehicle },
  });

  expect((await searchEvent(page)).freetext_place).toBe('from');
});

test('two Google-picked ends report both', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=${encodeURIComponent(UNKNOWN_FROM)}&to=${encodeURIComponent(UNKNOWN_TO)}`,
    estimate: { respond: byVehicle },
  });

  expect((await searchEvent(page)).freetext_place).toBe('both');
});

test('the flag stays low-cardinality — never the place name itself', async ({ page }) => {
  await gotoBooking(page, {
    path: '/search.html',
    query: `from=cmb-airport&to=${encodeURIComponent(UNKNOWN_TO)}`,
    estimate: { respond: byVehicle },
  });

  const ev = await searchEvent(page);
  // Four values, forever. A raw place name here would degrade into GA4's "(other)" bucket
  // and cost a custom dimension to do it.
  expect(['none', 'from', 'to', 'both']).toContain(ev.freetext_place);
  expect(ev.freetext_place).not.toContain('Sigiriya');
});
