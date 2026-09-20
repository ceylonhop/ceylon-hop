import { test, expect } from '@playwright/test';
import { blockLiveApi, installStubs } from './_stubs.js';

// A trip can contain a stretch the traveller arranges themselves — leg 1 ends in Ella, leg 2 starts
// in Galle, and we neither drive nor charge for Ella→Galle. The planner must never draw a driving
// line across that stretch, which is right and stays right.
//
// The way it avoided drawing it was to give up on the real map ENTIRELY (`if(!gapSet.size && ...`)
// and fall back to a hand-drawn picture: an oval standing in for Sri Lanka with dots on it. Any
// trip with a gap lost its map. A friend reviewing the planner read that oval as a broken map, and
// they were not wrong to.
//
// ch-map.js already had the mechanism — `opts.runs`, one route query per stretch, built for
// quote.html's per-leg road choices. A gap is the same shape: split the journey there, draw each
// stretch, leave the gap undrawn. Nothing new in the shared map component.
//
// The SVG stays as the honest FAILURE path (Google unreachable / no key), which is what
// plan-itinerary-gaps.spec.js pins by aborting maps.googleapis.com.

const GAPPED = '/plan.html?stops=' + encodeURIComponent('Kandy|Ella|Galle|Mirissa') + '&gaps=1&pax=2&vehicle=car';
const WHOLE = '/plan.html?stops=' + encodeURIComponent('Kandy|Ella|Mirissa') + '&pax=2&vehicle=car';

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.addInitScript(installStubs);
  await page.addInitScript(() => {
    // ch-map.js assigns window.CH_MAP in one shot at the end of its own script, and plan.js calls
    // renderRoute on load — too tight a race to win by polling. Intercept the assignment itself.
    window.__mapCalls = [];
    let real = null;
    Object.defineProperty(window, 'CH_MAP', {
      configurable: true,
      get: () => real,
      set: (v) => {
        real = v;
        if (v && typeof v.renderRoute === 'function') {
          const orig = v.renderRoute.bind(v);
          v.renderRoute = (host, stops, opts) => {
            window.__mapCalls.push({
              stops: JSON.parse(JSON.stringify(stops)),
              runs: opts && opts.runs ? opts.runs.map((r) => r.stops) : null,
            });
            return orig(host, stops, opts);
          };
        }
      },
    });
  });
});

const lastCall = (page) => page.evaluate(() => window.__mapCalls[window.__mapCalls.length - 1] || null);

test('a trip with a self-arranged stretch keeps the real map, split at the gap', async ({ page }) => {
  await page.goto(GAPPED);
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);

  await expect.poll(() => page.evaluate(() => window.__mapCalls.length)).toBeGreaterThan(0);
  const call = await lastCall(page);

  // Every stop is still handed over, so the legend numbers the whole journey 1–4...
  expect(call.stops).toEqual(['Kandy', 'Ella', 'Galle', 'Mirissa']);
  // ...but it is DRAWN as two stretches, and Ella→Galle is in neither of them.
  expect(call.runs).toEqual([['Kandy', 'Ella'], ['Galle', 'Mirissa']]);

  // The real map is on screen, not the stand-in drawing.
  await expect(page.locator('#trip-map .ch-map-wrap')).toBeVisible();
  await expect(page.locator('#trip-map .tm-route')).toHaveCount(0);

  // The legend still reads as ONE journey, numbered straight through the gap. Splitting the
  // drawing must not renumber the stops — ch-map builds the legend from the flat stop list while
  // the runs decide only what gets a line, and this is the assertion that holds those two apart.
  // The legend lives in the EXPANDED map (the inline card has no room for it), so open it.
  await page.locator('#trip-map .ch-map-expand').click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();
  await expect(page.locator('.ch-map-modal .ch-lg-n')).toHaveText(['1', '2', '3', '4']);
  await expect(page.locator('.ch-map-modal .ch-map-legend li')).toHaveText([
    /Kandy/, /Ella/, /Galle/, /Mirissa/,
  ]);

  // The expanded map draws the same split as the card it expands — not one line across the gap.
  const expanded = await lastCall(page);
  expect(expanded.runs).toEqual([['Kandy', 'Ella'], ['Galle', 'Mirissa']]);
});

test('an unbroken trip is unchanged — one stretch, and no runs asked for at all', async ({ page }) => {
  await page.goto(WHOLE);
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);

  await expect.poll(() => page.evaluate(() => window.__mapCalls.length)).toBeGreaterThan(0);
  const call = await lastCall(page);

  expect(call.stops).toEqual(['Kandy', 'Ella', 'Mirissa']);
  // No gaps, so nothing to split: plan.js passes no runs and ch-map draws the single default
  // route it always has. Pinned so this change cannot quietly turn one query into several.
  expect(call.runs).toBeNull();
});
