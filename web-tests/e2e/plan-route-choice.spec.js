import { test, expect } from '@playwright/test';
import { blockLiveApi, installStubs } from './_stubs.js';

/*
  Route choice on the plan page (spec 2026-09-26 §4.7).

  After the drives change, the planner sends ONE estimate-batch request with a `compareRoutes`
  car intent per drive. A drive whose answer carries a `routeChoice` gains a chip on its card,
  and the earliest undecided one is offered once, in the shared popup, when the page is quiet.

  The engine answer decides only WHETHER a cheaper fork exists and its km/time. Every price on
  this page stays the planner's own (legPrice at that road's km), labelled "about".

  CMB airport → Ella: expressway 335 km / 299 min; local road 213 km / 374 min.
  The planner's car prices: $140 at the catalogue's 335 km, $89.99 at 213 km — save about $50.
*/

const STOPS = 'Colombo Airport (CMB)|Ella|Yala';
const PLAN = '/plan.html?stops=' + encodeURIComponent(STOPS) + '&nights=0,1,0&pax=2';

const CHOICE = {
  fastest: { distanceKm: 335, durationMin: 299, totalCents: 14000 },
  noTolls: { distanceKm: 213, durationMin: 374, totalCents: 9100 },
};
const isCmbElla = (i) => i.legs && i.legs[0].from === 'Colombo Airport (CMB)' && i.legs[0].to === 'Ella';

// Records every batch request and answers CMB → Ella with a cheaper local road. `gate`, when
// given, holds each answer until the test releases it.
async function stubBatch(page, { gate = null } = {}) {
  const calls = [];
  await page.route('**/quote/v2/estimate-batch', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    calls.push(body);
    if (gate) await gate;
    const results = (body.intents || []).map((i) => (isCmbElla(i)
      ? { totalCents: 14000, currency: 'USD', routeChoice: CHOICE }
      : { totalCents: 5600, currency: 'USD' }));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  return calls;
}

let live;   // API requests nothing stubbed: they would have gone to the production API
test.beforeEach(async ({ page }) => {
  live = [];
  // Registered FIRST, so every stub below wins over it (the later route has priority): only a
  // request nothing else answered lands here. The offline test server rewrites a live-API
  // destination to its own origin with the path intact (serve-booking.js), so the batch is
  // matched by its path as well as by the production host.
  await page.route(
    (u) => /(^|\.)onrender\.com$/.test(u.hostname) || u.pathname === '/quote/v2/estimate-batch',
    (r) => { live.push(r.request().url()); return r.abort(); },
  );
  // the live price list: answered as unavailable, so the planner prices on the baked copy
  await page.route('**/quote/pricing', (r) => r.fulfill({ status: 404, body: '' }));
  await blockLiveApi(page);
  await page.addInitScript(installStubs);
});

const card = (page, i) => page.locator(`#rail .leg-card[data-i="${i}"]`);
const chip = (page, i) => card(page, i).locator('.lm-road');
const dist = (page, i) => card(page, i).locator('.lm-dist');
const pushes = (page, event) => page.evaluate((ev) => (window.dataLayer || []).filter((e) => e && e.event === ev), event);
const dollars = (s) => Number(String(s).replace(/[^0-9.–-]/g, '').split(/[–-]/).pop());
// "Approx. 335 km · 5h" → { km: '335 km', time: '5h' }
async function cardFigures(page, i) {
  const t = (await dist(page, i).textContent()).trim();
  const m = t.match(/Approx\. (\d+ km) · (.+)$/);
  expect(m, `card distance "${t}"`).toBeTruthy();
  return { km: m[1], time: m[2] };
}
async function popupFigures(dialog, cls) {
  const opt = dialog.locator(`label.ch-rc-opt.${cls}`);
  return {
    km: (await opt.locator('.ch-rc-stats').textContent()).split(' · ')[0],
    time: (await opt.locator('.ch-rc-time').textContent()).trim(),
  };
}
async function pickLocal(page) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('label.ch-rc-opt.is-local').click();
  await dialog.getByRole('button', { name: 'Use local road' }).click();
  await expect(dialog).toHaveCount(0);
}

test('one batch checks every drive; only the forked drive gets a chip', async ({ page }) => {
  const calls = await stubBatch(page);
  await page.goto(PLAN);
  await expect(chip(page, 0)).toContainText('Cheaper local road · save about $50');
  expect(calls).toHaveLength(1);
  expect(calls[0].intents).toHaveLength(2);
  expect(calls[0].intents.every((i) => i.compareRoutes === true && i.product === 'private' && i.vehicle === 'car')).toBe(true);
  await expect(chip(page, 2)).toHaveCount(0);
  // nothing more is asked once the drives are known
  await page.waitForTimeout(1200);
  expect(calls).toHaveLength(1);
  expect(live).toEqual([]);
});

test('the popup opens once, and describes each road with the card\'s own figures', async ({ page }) => {
  await stubBatch(page);
  await page.goto(PLAN);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('heading')).toHaveText('Two roads to Ella');
  await expect(dialog).toContainText('about $140');
  await expect(dialog).toContainText('about $89.99');
  await expect(dialog).toContainText('Save about $50');
  expect(await popupFigures(dialog, 'is-fastest')).toEqual(await cardFigures(page, 0));

  await pickLocal(page);
  // reopen from the chip: the local road's figures are the card's figures now
  await chip(page, 0).click();
  await expect(dialog).toBeVisible();
  expect(await popupFigures(dialog, 'is-local')).toEqual(await cardFigures(page, 0));
  await expect(dialog.locator('.ch-rc-slower')).toHaveText('+1h');
  await dialog.getByRole('button', { name: 'Decide later' }).click();
  await expect(dialog).toHaveCount(0);
});

test('picking the local road reprices the card, the guide total and the map', async ({ page }) => {
  await stubBatch(page);
  await page.goto(PLAN);
  await expect(page.getByRole('dialog')).toBeVisible();
  const totalBefore = dollars(await page.locator('#sum-amt').textContent());
  const mapReqsBefore = await page.evaluate(() => (window.__computeRoutesReqs || []).length);
  await pickLocal(page);

  await expect(chip(page, 0)).toHaveText('Road: Local road ▾');
  await expect(dist(page, 0)).toContainText('215 km');     // 213 km, rounded as every distance here is
  await expect(card(page, 0).locator('.lm-price b')).toHaveText('$89.99');
  await expect.poll(async () => dollars(await page.locator('#sum-amt').textContent())).toBeLessThan(totalBefore);
  expect(await pushes(page, 'route_choice')).toEqual([
    expect.objectContaining({ choice: 'no_tolls', source: 'popup', page: 'plan', saving_usd: 50 }),
  ]);
  // the map is redrawn along the road now priced
  await expect.poll(() => page.evaluate((n) => (window.__computeRoutesReqs || []).slice(n)
    .some((r) => r.routeModifiers && r.routeModifiers.avoidTolls === true), mapReqsBefore)).toBe(true);
  expect(new URL(page.url()).searchParams.get('roads')).toBe('no_tolls,');
});

test('the booking hand-off carries the road and its distance', async ({ page }) => {
  await stubBatch(page);
  await page.goto(PLAN);
  await pickLocal(page);
  await page.locator('#request-btn').click();
  await page.locator('#fork-later').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  const q = new URL(page.url()).searchParams;
  expect(q.get('roads')).toBe('no_tolls,');
  expect(q.get('kms').startsWith('213')).toBe(true);
});

test('a focused field holds the popup until focus leaves it, then it opens once', async ({ page }) => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const calls = await stubBatch(page, { gate });
  await page.goto(PLAN);
  const field = card(page, 2).locator('.leg-from');
  await field.focus();
  await expect.poll(() => calls.length).toBe(1);
  release();
  await expect(chip(page, 0)).toContainText('Cheaper local road');
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(field).toBeFocused();

  await page.locator('h1').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('changing the drive\'s drop-off drops its road', async ({ page }) => {
  await stubBatch(page);
  await page.goto(PLAN);
  await pickLocal(page);
  await expect.poll(() => new URL(page.url()).searchParams.get('roads')).toBe('no_tolls,');

  const to = card(page, 0).locator('.leg-to');
  await to.click();
  await to.fill('');
  await to.pressSequentially('Kandy', { delay: 20 });
  await page.locator('.place-menu .place-option', { hasText: 'Kandy' }).first().click();
  await expect(card(page, 0).locator('.leg-to')).toHaveValue('Kandy');
  await expect(chip(page, 0)).toHaveCount(0);
  await expect(dist(page, 0)).not.toContainText('215 km');
  await expect.poll(() => new URL(page.url()).searchParams.has('roads')).toBe(false);
});

test('a reload keeps the choice through roads= and does not ask again', async ({ page }) => {
  const calls = await stubBatch(page);
  await page.goto(PLAN);
  await pickLocal(page);
  await expect.poll(() => new URL(page.url()).searchParams.get('roads')).toBe('no_tolls,');

  await page.reload();
  await expect(chip(page, 0)).toHaveText('Road: Local road ▾');
  await expect(dist(page, 0)).toContainText('215 km');
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls).toHaveLength(2);   // the reload re-checks the drives once
  expect(new URL(page.url()).searchParams.get('roads')).toBe('no_tolls,');
});

test('with the API off no batch is sent and no chip is shown', async ({ page }) => {
  const calls = await stubBatch(page);
  await page.goto(PLAN + '&api=off');
  await expect(card(page, 0).locator('.lm-dist')).toContainText('335 km');
  await page.waitForTimeout(1500);
  expect(calls).toHaveLength(0);
  await expect(page.locator('#rail .lm-road')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
