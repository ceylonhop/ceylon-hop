import { test, expect } from '@playwright/test';
import { gotoBooking, blockLiveApi } from './_stubs.js';

/*
  Route choice on the search page (spec 2026-09-26 §4.5–4.6).

  When the toll-free local road is cheaper than the expressway, the engine answers a
  `compareRoutes` estimate with a `routeChoice` for both roads. The page offers the local road
  ONCE per pair per tab (a popup), then keeps a two-road switch on the private card, so the
  choice stays reversible without another request.

  CMB airport → Ella: expressway 335 km / 299 min at $140 car / $189 van; the local road
  213 km / 374 min at $91 / $123 — "Save $49".
*/

const choice = (intent) => {
  const car = intent.vehicle !== 'van';
  const fast = car ? 14000 : 18900, local = car ? 9100 : 12300;
  return {
    fast, local,
    routeChoice: {
      fastest: { distanceKm: 335, durationMin: 299, totalCents: fast },
      noTolls: { distanceKm: 213, durationMin: 374, totalCents: local },
    },
  };
};

// `calls.n` counts every estimate request the page makes.
// `localKm` overrides the local road's distanceKm in the routeChoice (a malformed answer).
function responder({ withChoice = true, localKm } = {}) {
  const calls = { n: 0, intents: [] };
  const respond = (intent) => {
    calls.n += 1;
    calls.intents.push(intent);
    const c = choice(intent);
    if (localKm !== undefined) c.routeChoice.noTolls.distanceKm = localKm;
    return {
      totalCents: c.fast,
      legs: [{ from: intent.legs[0].from, to: intent.legs[0].to, distanceKm: 335, durationMin: 299 }],
      ...(withChoice && intent.compareRoutes ? { routeChoice: c.routeChoice } : {}),
    };
  };
  return { calls, respond };
}

const open = async (page, { query = 'from=cmb-airport&to=ella', withChoice = true, localKm } = {}) => {
  const r = responder({ withChoice, localKm });
  await gotoBooking(page, { path: '/search.html', query, estimate: { respond: r.respond } });
  return r.calls;
};

const rows = (page) => page.locator('.opt-private .veh-row');
const carHref = (page) => rows(page).nth(0).locator('a.btn').getAttribute('href');
const pushes = (page, event) => page.evaluate((ev) => (window.dataLayer || []).filter((e) => e && e.event === ev), event);
const cardSwitch = (page) => page.locator('.opt-private [role="radiogroup"][aria-label="Road"]');
// The meta line's figures for the road on the card: "Approx. 335 km · 5h[ · via local road]".
async function metaFigures(page) {
  const t = (await page.locator('#route-meta .route-estimate').textContent()).trim();
  const m = t.match(/Approx\. (\d+ km) · (.+?)(?: · via local road)?$/);
  expect(m, `meta line "${t}"`).toBeTruthy();
  return { km: m[1], time: m[2] };
}
// The popup's figures for one road ('is-fastest' | 'is-local'): its km and its time.
async function popupFigures(dialog, cls) {
  const card = dialog.locator(`label.ch-rc-opt.${cls}`);
  return {
    km: (await card.locator('.ch-rc-stats').textContent()).split(' · ')[0],
    time: (await card.locator('.ch-rc-time').textContent()).trim(),
  };
}

test('a cheaper local road is offered once, in a popup', async ({ page }) => {
  const calls = await open(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('heading')).toHaveText('Two roads to Ella');
  await expect(dialog).toContainText('Save $49');
  await expect(dialog).toContainText('$140');
  await expect(dialog).toContainText('$91');
  // the popup asked with compareRoutes, one vehicle at a time
  expect(calls.intents.every((i) => i.compareRoutes === true)).toBe(true);
  expect(calls.intents.map((i) => i.vehicle)).toEqual(['car', 'van']);
});

test('picking the local road reprices the card, the meta line and the Select links', async ({ page }) => {
  await open(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // One road, one set of figures: the popup describes each road exactly as the meta line will.
  const fast = await popupFigures(dialog, 'is-fastest');
  const local = await popupFigures(dialog, 'is-local');
  expect(fast).toEqual(await metaFigures(page));
  expect(fast).toEqual({ km: '335 km', time: '5h' });        // 297 min rounds as the meta line does
  expect(local).toEqual({ km: '215 km', time: '6h' });       // 213 km / 374 min, rounded
  // each card shows only its own drive time — no "+1h" (owner, 2026-09-27: it read as a sum)
  await expect(dialog.locator('label.ch-rc-opt.is-local .ch-rc-alt')).toHaveText('6h');
  await expect(dialog).not.toContainText('+1h');
  await dialog.locator('label.ch-rc-opt.is-local').click();
  await dialog.getByRole('button', { name: 'Use local road' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(rows(page).nth(0)).toContainText('$91');
  await expect(rows(page).nth(1)).toContainText('$123');
  // route-estimate.js rounds a displayed distance to 5 km, so 213 km reads "215 km"
  await expect(page.locator('#route-meta')).toContainText('via local road');
  expect(await metaFigures(page)).toEqual(local);
  const q = new URLSearchParams((await carHref(page)).split('?')[1]);
  expect(q.get('road')).toBe('no_tolls');
  expect(q.get('estimateKm')).toBe('213');
  expect(q.get('estimateMin')).toBe('374');
  expect(q.get('price')).toBe('91');
  const rc = await pushes(page, 'route_choice');
  expect(rc).toEqual([expect.objectContaining({ choice: 'no_tolls', source: 'popup', page: 'search', saving_usd: 49 })]);
  // a switch is not a new search
  expect(await pushes(page, 'search')).toHaveLength(1);
  expect(await pushes(page, 'view_item_list')).toHaveLength(1);
  await expect(cardSwitch(page).locator('input:checked')).toHaveValue('no_tolls');
});

test('closing keeps the expressway, and a reload does not ask again', async ({ page }) => {
  await open(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rows(page).nth(0)).toContainText('$140');
  expect(new URLSearchParams((await carHref(page)).split('?')[1]).has('road')).toBe(false);
  expect(await pushes(page, 'route_choice')).toEqual([expect.objectContaining({ choice: 'dismissed', source: 'popup', saving_usd: 49 })]);

  await page.reload();
  await expect(rows(page).nth(0)).toContainText('$140');
  await expect(cardSwitch(page)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the card switch moves both ways without asking the engine again', async ({ page }) => {
  const calls = await open(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(rows(page).nth(0)).toContainText('$140');
  const asked = calls.n;

  const sw = cardSwitch(page);
  // the switch uses the meta line's figures too
  await expect(sw.locator('label')).toHaveText(['Expressway · 5h', 'Local road · 6h']);
  await sw.locator('label', { hasText: 'Local road · 6h' }).click();
  await expect(rows(page).nth(0)).toContainText('$91');
  await expect(rows(page).nth(1)).toContainText('$123');
  await expect(cardSwitch(page).locator('input:checked')).toHaveValue('no_tolls');
  expect((await metaFigures(page)).time).toBe('6h');
  // the expressway's time is the catalogue's (297 min), rounded as the meta line rounds it
  await cardSwitch(page).locator('label', { hasText: /^Expressway · 5h$/ }).click();
  await expect(rows(page).nth(0)).toContainText('$140');
  await expect(rows(page).nth(1)).toContainText('$189');
  await expect(page.locator('#route-meta')).not.toContainText('via local road');
  expect(await metaFigures(page)).toEqual({ km: '335 km', time: '5h' });
  expect(new URLSearchParams((await carHref(page)).split('?')[1]).get('estimateKm')).toBe('335');

  expect(calls.n).toBe(asked);
  const rc = (await pushes(page, 'route_choice')).filter((e) => e.source === 'card');
  expect(rc.map((e) => e.choice)).toEqual(['no_tolls', 'fastest']);
});

test('no routeChoice in the answer: no popup, no switch', async ({ page }) => {
  await open(page, { withChoice: false });
  await expect(rows(page).nth(0)).toContainText('$140');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(cardSwitch(page)).toHaveCount(0);
});

test('the catalogue fallback never offers a road', async ({ page }) => {
  await blockLiveApi(page);
  await page.goto('/search.html?from=cmb-airport&to=ella');
  await expect(rows(page).nth(0)).toContainText('$140', { timeout: 10000 });
  await expect(page.locator('.opt-private.is-pending')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(cardSwitch(page)).toHaveCount(0);
});

test('on a phone the popup is a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const b = await dialog.boundingBox();
    return b ? Math.abs(b.y + b.height - 812) : 999;
  }).toBeLessThanOrEqual(2);
  const b = await dialog.boundingBox();
  expect(b.x).toBe(0);
  expect(b.width).toBe(375);
  // nothing in the sheet runs off the side
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
});

test('Escape closes the popup', async ({ page }) => {
  await open(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(rows(page).nth(0)).toContainText('$140');
});

test('road=no_tolls in the URL preselects the local road and asks nothing', async ({ page }) => {
  await open(page, { query: 'from=cmb-airport&to=ella&road=no_tolls' });
  await expect(rows(page).nth(0)).toContainText('$91');
  await expect(rows(page).nth(1)).toContainText('$123');
  await expect(cardSwitch(page).locator('input:checked')).toHaveValue('no_tolls');
  await expect(page.locator('#route-meta')).toContainText('via local road');
  expect(new URLSearchParams((await carHref(page)).split('?')[1]).get('road')).toBe('no_tolls');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/* The shared seat is a scheduled service on its own road: its "Book a seat" link must never carry
   the private car's local road, nor that road's km/min. Negombo → Sigiriya runs a Saturday seat;
   the catalogue (the expressway on a baked pair) says 148 km / 194 min. */
const SHARED_ROUTE = 'from=negombo&to=sigiriya&date=2099-08-15';
const seatHref = async (page) => new URLSearchParams(
  (await page.locator('#shared-option a.o-cta').getAttribute('href')).split('?')[1]);

test('picking the local road leaves the shared seat on the expressway figures', async ({ page }) => {
  await open(page, { query: SHARED_ROUTE });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('label.ch-rc-opt.is-local').click();
  await dialog.getByRole('button', { name: 'Use local road' }).click();
  await expect(rows(page).nth(0)).toContainText('$91');
  expect(new URLSearchParams((await carHref(page)).split('?')[1]).get('road')).toBe('no_tolls');
  const q = await seatHref(page);
  expect(q.get('mode')).toBe('shared');
  expect(q.has('road')).toBe(false);
  expect(q.get('estimateKm')).toBe('148');
  expect(q.get('estimateMin')).toBe('194');
});

test('road=no_tolls in the URL still leaves the shared seat on the expressway figures', async ({ page }) => {
  await open(page, { query: SHARED_ROUTE + '&road=no_tolls' });
  await expect(rows(page).nth(0)).toContainText('$91');
  const q = await seatHref(page);
  expect(q.has('road')).toBe(false);
  expect(q.get('estimateKm')).toBe('148');
  expect(q.get('estimateMin')).toBe('194');
});

test('a local road with no real distance is never offered', async ({ page }) => {
  await open(page, { localKm: 0 });
  await expect(rows(page).nth(0)).toContainText('$140');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(cardSwitch(page)).toHaveCount(0);
  expect(new URLSearchParams((await carHref(page)).split('?')[1]).has('road')).toBe(false);
});

// A page opened in a background tab: visibilityState reads 'hidden' until the test "switches" to it.
const hideTab = (page) => page.addInitScript(() => {
  window.__vis = 'hidden';
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__vis; } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__vis !== 'visible'; } });
});
const setTab = (page, vis) => page.evaluate((v) => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')); }, vis);

test('a search opened in a background tab offers the road when the tab is first shown, once', async ({ page }) => {
  await hideTab(page);
  await open(page);
  await expect(rows(page).nth(0)).toContainText('$140');
  await expect(cardSwitch(page)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);   // nobody is looking yet

  await setTab(page, 'visible');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // leaving the tab and coming back never asks again
  await setTab(page, 'hidden');
  await setTab(page, 'visible');
  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
