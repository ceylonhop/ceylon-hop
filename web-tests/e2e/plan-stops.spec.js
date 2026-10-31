import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
  { name: 'tablet', viewport: { width: 768, height: 1024 } },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});

const CHAIN = 'Kandy|Sigiriya / Dambulla|Ella';
const url = (extra = '') => '/plan.html?stops=' + encodeURIComponent(CHAIN) + '&nights=0,0,0&through=0&pax=2&vehicle=car' + extra;

// The engine offers every leg a road choice, so a plain leg renders its .lm-road chip offline.
const stubRoadChoice = (page) => page.route('**/quote/v2/estimate-batch', async (r) => {
  const body = JSON.parse(r.request().postData() || '{}');
  const results = (body.intents || []).map(() => ({ totalCents: 9000, currency: 'USD', routeChoice: {
    fastest: { distanceKm: 130, durationMin: 120, totalCents: 9000 },
    noTolls: { distanceKm: 116, durationMin: 170, totalCents: 8000 } } }));
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
});

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile });

    test('loads a through wire as one leg with a stop row', async ({ page }) => {
      await page.goto(url());
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveValue('Sigiriya / Dambulla');
      await expect(page.locator('#st-stops')).toHaveText('3');
      await expect(page.locator('#st-legs')).toHaveText('1');
      await expect(page.locator('#sum-route')).toContainText('Kandy');
      await expect(page.locator('#sum-route')).toContainText('Ella');
      // no horizontal overflow at this width
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(over).toBe(false);
    });

    test('hands the stop to booking as through, and back again on edit', async ({ page }) => {
      await page.goto(url());
      // Kandy → Sigiriya → Ella is a ≥ 6 h day: answer the long-day ask before Next.
      await page.locator('.leg-warn.long-day .dw-keep').click();
      await page.locator('#request-btn').click();
      await page.locator('#dates-continue').click();
      await page.waitForURL('**/booking.html?**');
      const q = new URL(page.url()).searchParams;
      expect(q.get('stops')).toBe(CHAIN);
      expect(q.get('through')).toBe('0');
      expect(q.get('ack')).toBe('0');
      await page.locator('.tr-edit').click();
      await page.waitForURL('**/plan.html?**');
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveCount(1);
    });

    test('adds a stop on the way, prices the whole chain, and removes it again', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card.locator('.add-via')).toHaveText(/Add a stop on the way/);
      // the direct Kandy→Ella figure, so the chain sum below is proven to replace it
      const kmOf = async () => Number(((await card.locator('.lm-dist').textContent()) || '').match(/([\d,]+)\s*km/)[1].replace(/,/g, ''));
      const directKm = await kmOf();
      await card.locator('.add-via').click();
      const via = card.locator('.leg-via');
      await expect(via).toBeFocused();
      await via.fill('Sigiriya');
      await expect(page.locator('.place-menu')).toBeVisible();
      await page.locator('.place-option', { hasText: 'Sigiriya' }).first().click();
      await expect(card.locator('.add-via')).toHaveText(/Add another stop/);
      await expect(card.locator('.leg-meta')).toContainText('km');
      // Kandy→Sigiriya→Ella is longer than Kandy→Ella: the card prices the summed chain
      await expect.poll(kmOf).toBeGreaterThan(directKm);
      await expect(page.locator('#st-stops')).toHaveText('3');
      await expect(page.locator('#st-legs')).toHaveText('1');
      // controls: hover (or always, on touch) shows swap + remove on every row
      const dropRow = card.locator('.rb-field').last();
      await dropRow.hover();
      await expect(dropRow.locator('.stop-swap')).toBeVisible();
      await expect(dropRow.locator('.stop-rm')).toBeVisible();
      // remove the stop → back to a plain leg
      const viaRow = card.locator('.rb-field.via');
      await viaRow.hover();
      await viaRow.locator('.stop-rm').click();
      await expect(card.locator('.leg-via')).toHaveCount(0);
      await expect(card.locator('.stop-rm')).toHaveCount(0); // a two-place leg has no ×
      await expect(page.locator('#st-stops')).toHaveText('2');
    });

    test('⇅ on a row swaps it with the row below; on the last row, with the row above', async ({ page }) => {
      await page.goto(url());
      const card = page.locator('#rail .leg-card').first();
      const rows = card.locator('.rb-field');
      await rows.nth(0).hover();
      await rows.nth(0).locator('.stop-swap').click();
      await expect(card.locator('.leg-from')).toHaveValue('Sigiriya / Dambulla');
      await expect(card.locator('.leg-via')).toHaveValue('Kandy');
      await rows.nth(2).hover();
      await rows.nth(2).locator('.stop-swap').click();
      await expect(card.locator('.leg-via')).toHaveValue('Ella');
      await expect(card.locator('.leg-to')).toHaveValue('Kandy');
    });

    test('a stay card has no add-stop link; the cap hides it at 4 stops', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&nights=1,0&pax=2&vehicle=car');
      await expect(page.locator('.leg.is-stay .add-via')).toHaveCount(0);
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Anuradhapura|Trincomalee|Ella|Galle') + '&nights=0,0,0,0,0,0&through=0,1,2,3&pax=2&vehicle=car');
      await expect(page.locator('#rail .leg-via')).toHaveCount(4);
      await expect(page.locator('.add-via')).toBeHidden();
    });

    test('a leg with a stop drops its road chip and sends no road', async ({ page }) => {
      // the engine offers CMB→Galle a local road, so the plain leg shows its chip first —
      // without this the chip never renders offline and the count-0 check below is vacuous
      await stubRoadChoice(page);
      await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo Airport (CMB)|Galle') + '&roads=no_tolls&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card.locator('.lm-road')).toHaveCount(1);
      await card.locator('.add-via').click();
      const via = card.locator('.leg-via');
      await via.fill('Hikkaduwa');
      await page.locator('.place-option', { hasText: 'Hikkaduwa' }).first().click();
      await expect(card.locator('.lm-road')).toHaveCount(0);
      await page.locator('#request-btn').click();
      await page.locator('#dates-continue').click();
      await page.waitForURL('**/booking.html?**');
      expect(new URL(page.url()).searchParams.get('roads')).toBeNull();
    });

    // A blank stop row is not a stop: the leg keeps its price, its road chip and the chosen road.
    test('an empty stop row keeps the leg\'s price and its chosen road', async ({ page }) => {
      await stubRoadChoice(page);
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&roads=no_tolls&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card.locator('.lm-road')).toHaveCount(1);
      await card.locator('.add-via').click();
      await expect(card.locator('.leg-via')).toHaveValue('');
      await expect(card.locator('.leg-meta')).toContainText('km');
      await expect(card.locator('.leg-meta')).not.toContainText('Pick both points');
      await expect(card.locator('.lm-road')).toHaveCount(1);
      const viaRow = card.locator('.rb-field.via');
      await viaRow.hover();
      await viaRow.locator('.stop-rm').click();
      await expect(card.locator('.leg-via')).toHaveCount(0);
      await expect(card.locator('.lm-road')).toHaveCount(1);
      expect(new URL(page.url()).searchParams.get('roads') || '').toContain('no_tolls');
    });

    // Guards the Task 17 fix: a blank stop row is filtered out of the wire chain, so the leg
    // stays one Kandy→Ella wire in the URL (no gap, no through) and reloads as one leg.
    // render() ends with syncPlanUrl(), so the add-via click has already rewritten the URL.
    test('a blank stop on the way leaves the leg intact in the URL', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.add-via').click();
      await expect(card.locator('.leg-via')).toHaveCount(1);
      await expect(card.locator('.leg-via')).toHaveValue('');
      const q = new URL(page.url()).searchParams;
      expect(q.has('gaps')).toBe(false);
      expect(q.has('through')).toBe(false);
      expect(q.get('stops')).toBe('Kandy|Ella');
      await page.reload();
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-from')).toHaveValue('Kandy');
      await expect(page.locator('#rail .leg-to')).toHaveValue('Ella');
    });
  });
}

test('kill switch off: the same URL loads as two plain legs and offers no add-stop link', async ({ page }) => {
  await page.addInitScript(() => { window.__CH_PLANNER_STOPS_OFF = true; });
  await page.goto(url());
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await expect(page.locator('.add-via')).toHaveCount(0);
});

// `ack` is a wire index, like `through` and `gaps`: the run whose HEAD wire it names. Two runs —
// Kandy→Sigiriya→Ella (wires 0,1) and Ella→Galle (wire 2) — so ack=2 is the SECOND leg, not leg 2.
test('ack names the head wire of a run and round-trips to booking unchanged', async ({ page }) => {
  const stops = 'Kandy|Sigiriya / Dambulla|Ella|Galle';
  await page.goto('/plan.html?stops=' + encodeURIComponent(stops) + '&nights=0,0,0,0&through=0&ack=2&pax=2&vehicle=car');
  const cards = page.locator('#rail .leg-card');
  await expect(cards).toHaveCount(2);
  // the first leg (Kandy → Sigiriya → Ella, ≥ 6 h) still asks; the second arrived acked
  await expect(cards.nth(0).locator('.leg-warn.long-day')).toHaveCount(1);
  await expect(cards.nth(1).locator('.leg-warn.long-day')).toHaveCount(0);
  await cards.nth(0).locator('.dw-keep').click();
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  const q = new URL(page.url()).searchParams;
  expect(q.get('stops')).toBe(stops);
  expect(q.get('through')).toBe('0');
  expect(q.get('ack')).toBe('0,2');
});

// `dates` is per WIRE too: every wire of a run carries its leg's date. Kandy→Sigiriya→Ella
// (wires 0,1) is on 12-01 and Ella→Galle (wire 2) on 12-03, so the second leg reads dates[2].
test('dates are read by each leg\'s head wire and round-trip to booking unchanged', async ({ page }) => {
  const stops = 'Kandy|Sigiriya / Dambulla|Ella|Galle';
  const dates = '2026-12-01,2026-12-01,2026-12-03';
  await page.goto('/plan.html?stops=' + encodeURIComponent(stops) + '&nights=0,0,0,0&through=0&dates=' + dates + '&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  // only the first leg (Kandy → Sigiriya → Ella) is a ≥ 6 h day: keep it to reach Next
  await expect(page.locator('.leg-warn.long-day')).toHaveCount(1);
  await page.locator('#rail .leg-card').nth(0).locator('.dw-keep').click();
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  const q = new URL(page.url()).searchParams;
  expect(q.get('through')).toBe('0');
  expect(q.get('dates')).toBe(dates);
});

// A traveller-arranged gap keeps its empty date slot: wire 0 (Kandy→Sigiriya) on 12-01, wire 1
// (Sigiriya→Ella) a gap with no date, wire 2 (Ella→Galle) on 12-03 — the hand-off is unchanged.
test('a gap keeps its empty date slot and both round-trip to booking unchanged', async ({ page }) => {
  const stops = 'Kandy|Sigiriya / Dambulla|Ella|Galle';
  const dates = '2026-12-01,,2026-12-03';
  await page.goto('/plan.html?stops=' + encodeURIComponent(stops) + '&nights=0,0,0,0&gaps=1&dates=' + dates + '&pax=2&vehicle=car');
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  const q = new URL(page.url()).searchParams;
  expect(q.get('dates')).toBe(dates);
  expect(q.get('gaps')).toBe('1');
});
