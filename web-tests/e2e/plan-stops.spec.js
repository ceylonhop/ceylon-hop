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

    // A leg loaded with a stop (a through URL) cannot carry a road: the batch never asks for its
    // from→to pair and the "Two roads to X" popup never opens for it.
    test('a leg loaded with a stop is never batched for a road nor offered the popup', async ({ page }) => {
      await stubRoadChoice(page);
      const bodies = [];
      page.on('request', (req) => {
        if (req.url().includes('/quote/v2/estimate-batch')) bodies.push(JSON.parse(req.postData() || '{}'));
      });
      await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo Airport (CMB)|Hikkaduwa|Galle') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveValue('Hikkaduwa');
      await page.waitForTimeout(1200);   // longer than the 800 ms road debounce
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const pairs = bodies.flatMap((b) => (b.intents || []).flatMap((it) => (it.legs || []).map((l) => l.from + '>' + l.to)));
      expect(pairs).not.toContain('Colombo Airport (CMB)>Galle');
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

    // spec §3.3 asked for one pin per place in the SVG fallback; the owner chose to keep numbered pins in rail order (matches plan-pricing-map and the Google map) — the round-trip pin merge is a ch-map proposal
    test('the map draws one line through the stop and one numbered pin per route point', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Kandy') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      await expect(page.locator('#trip-map .tm-route')).toHaveCount(2);
      await expect(page.locator('#trip-map .tm-pin-label')).toHaveCount(3);
    });

    // Task 24: a + on the rail at every gap inserts a stop exactly there.
    const twoPlace = '/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&pax=2&vehicle=car';
    const opacityOf = (loc) => loc.evaluate((el) => getComputedStyle(el).opacity);
    const pick = async (page, card, text) => {
      await card.locator('.leg-via:focus').fill(text);
      await page.locator('.place-option', { hasText: text }).first().click();
    };

    if (vp.name !== 'phone') {
      test('insert: hovering the line between two places lights its + and "Stop here"', async ({ page }) => {
        await page.goto(twoPlace);
        const card = page.locator('#rail .leg-card').first();
        const btn = card.locator('.ins-btn[data-at="1"]');
        const tip = card.locator('.rb-divider.ins[data-at="1"] .ins-tip');
        await page.mouse.move(1, 1);
        await expect.poll(() => opacityOf(btn)).toBe('0');
        await card.locator('.rb-divider.ins[data-at="1"]').hover();
        await expect.poll(() => opacityOf(btn)).toBe('1');
        await expect(tip).toBeVisible();
        await expect(tip).toHaveText(/Stop here/i);
        await expect.poll(() => opacityOf(tip)).toBe('1');
        await expect(btn).toHaveAttribute('aria-label', 'Add a stop between Kandy and Ella');
      });

      test('insert: hovering the wire on the rail lights the same gap', async ({ page }) => {
        await page.goto(twoPlace);
        const card = page.locator('#rail .leg-card').first();
        await page.mouse.move(1, 1);
        await card.locator('.rb-wire[data-at="1"]').hover();
        await expect.poll(() => opacityOf(card.locator('.ins-btn[data-at="1"]'))).toBe('1');
        await expect(card.locator('.rb-divider.ins[data-at="1"]')).toHaveClass(/is-hot/);
        await expect.poll(() => opacityOf(card.locator('.ins-tip'))).toBe('1');
      });
    } else {
      test('insert: on a phone the + shows without hover and a tap inserts a row', async ({ page }) => {
        await page.goto(twoPlace);
        const card = page.locator('#rail .leg-card').first();
        const btn = card.locator('.ins-btn[data-at="1"]');
        await expect.poll(() => opacityOf(btn)).toBe('1');
        await expect(card.locator('.ins-tip')).toBeHidden();
        await btn.tap();
        await expect(card.locator('.leg-via')).toHaveCount(1);
        await expect(card.locator('.leg-via')).toBeFocused();
      });
    }

    test('insert: + at a gap inserts the stop there, in order', async ({ page }) => {
      await page.goto(twoPlace);
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.ins-btn[data-at="1"]').click();
      await expect(card.locator('.leg-via')).toBeFocused();
      await pick(page, card, 'Sigiriya');
      // the pick re-renders the card, which blurs the old field; its 120 ms menu-close grace
      // (wirePlaceSearch) would shut the NEXT field's menu if we typed inside it — a human can't
      await page.waitForTimeout(200);
      // gap 1 is now Kandy | Sigiriya: the next stop goes BEFORE Sigiriya
      await card.locator('.ins-btn[data-at="1"]').click();
      await expect(card.locator('.leg-via')).toHaveCount(2);
      await expect(card.locator('.leg-via').first()).toBeFocused();
      await pick(page, card, 'Nuwara Eliya');
      const values = await card.locator('.leg-via').evaluateAll((els) => els.map((e) => e.value));
      expect(values).toHaveLength(2);
      expect(values[0]).toMatch(/Nuwara Eliya/);
      expect(values[1]).toMatch(/Sigiriya/);
      await expect(card.locator('.leg-from')).toHaveValue('Kandy');
      await expect(card.locator('.leg-to')).toHaveValue('Ella');
    });

    test('insert: a row left blank is removed when focus leaves the card', async ({ page }) => {
      await page.goto(twoPlace);
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.ins-btn[data-at="1"]').click();
      await expect(card.locator('.leg-via')).toBeFocused();
      await expect(card.locator('.leg-via')).toHaveCount(1);
      await page.evaluate(() => document.activeElement.blur());
      await expect(card.locator('.leg-via')).toHaveCount(0);
      // the foot link's blank row goes the same way
      await card.locator('.add-via').click();
      await expect(card.locator('.leg-via')).toBeFocused();
      await page.evaluate(() => document.activeElement.blur());
      await expect(card.locator('.leg-via')).toHaveCount(0);
    });

    test('insert: leaving a blank row for another card\'s field drops the row and keeps that field focused', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella|Galle') + '&nights=0,0,0&pax=2&vehicle=car');
      const cards = page.locator('#rail .leg-card');
      await expect(cards).toHaveCount(2);
      await cards.nth(0).locator('.ins-btn[data-at="1"]').click();
      await expect(cards.nth(0).locator('.leg-via')).toBeFocused();
      await cards.nth(1).locator('.leg-to').click();
      await expect(cards.nth(0).locator('.leg-via')).toHaveCount(0);
      await expect(cards.nth(1).locator('.leg-to')).toBeFocused();
    });

    // Safari / Firefox-on-macOS: a <button> does not take focus on mousedown, so the blank row's
    // input blurs to <body> and the focusout check runs between mousedown and click. Chromium
    // can't produce that order on its own, so it is simulated here.
    test('insert: × on a blank row, pressed without the button taking focus, removes only that row', async ({ page }) => {
      await page.goto(twoPlace);
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.add-via').click();
      await expect(card.locator('.leg-via')).toBeFocused();
      await pick(page, card, 'Sigiriya');
      await page.waitForTimeout(200);
      await card.locator('.add-via').click();
      await expect(card.locator('.leg-via[data-k="2"]')).toBeFocused();
      await page.evaluate(async () => {
        const rm = () => document.querySelector('#rail .leg-card .stop-rm[data-k="2"]');
        rm().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        document.activeElement.blur();
        await new Promise((r) => setTimeout(r, 50));
        rm().dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        rm().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await expect(card.locator('.leg-from')).toHaveValue('Kandy');
      await expect(card.locator('.leg-via')).toHaveCount(1);
      await expect(card.locator('.leg-via')).toHaveValue('Sigiriya / Dambulla');
      await expect(card.locator('.leg-to')).toHaveValue('Ella');
    });

    test('insert: a blank row keeps a pick made from its own place menu', async ({ page }) => {
      await page.goto(twoPlace);
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.ins-btn[data-at="1"]').click();
      const via = card.locator('.leg-via');
      await expect(via).toBeFocused();
      await via.fill('K');
      await via.fill('');
      const opt = page.locator('.place-option').first();
      await expect(opt).toBeVisible();
      const place = await opt.getAttribute('data-place');
      await opt.click();
      await expect(card.locator('.leg-via')).toHaveCount(1);
      await expect(card.locator('.leg-via')).toHaveValue(place);
    });

    test('insert: no + at 4 stops, at 12 places, or on a leg with the same place twice', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Anuradhapura|Trincomalee|Ella|Galle') + '&nights=0,0,0,0,0,0&through=0,1,2,3&pax=2&vehicle=car');
      await expect(page.locator('#rail .leg-via')).toHaveCount(4);
      await expect(page.locator('.ins-btn')).toHaveCount(0);
      await expect(page.locator('.ins-tip')).toHaveCount(0);
      const twelve = ['Kandy', 'Sigiriya / Dambulla', 'Anuradhapura', 'Trincomalee', 'Ella', 'Galle', 'Mirissa', 'Tangalle', 'Nuwara Eliya', 'Negombo', 'Hikkaduwa', 'Colombo'];
      await page.goto('/plan.html?stops=' + encodeURIComponent(twelve.join('|')) + '&nights=' + twelve.map(() => 0).join(',') + '&pax=2&vehicle=car');
      await expect(page.locator('#rail .leg-card')).toHaveCount(11);
      await expect(page.locator('.ins-btn')).toHaveCount(0);
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Sigiriya / Dambulla') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      await expect(page.locator('#rail .leg-card').first()).toHaveClass(/leg-bad/);
      await expect(page.locator('.ins-btn')).toHaveCount(0);
      await expect(page.locator('.ins-tip')).toHaveCount(0);
    });

    test('insert: Tab reaches the + and Enter inserts', async ({ page }) => {
      await page.goto(twoPlace);
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.leg-from').focus();
      let reached = false;
      for (let n = 0; n < 6 && !reached; n++) {
        await page.keyboard.press('Shift+Tab');
        reached = await page.evaluate(() => !!document.activeElement && document.activeElement.matches('.ins-btn'));
      }
      expect(reached).toBe(true);
      await expect.poll(() => opacityOf(card.locator('.ins-btn[data-at="1"]'))).toBe('1');
      await page.keyboard.press('Enter');
      await expect(card.locator('.leg-via')).toHaveCount(1);
      await expect(card.locator('.leg-via')).toBeFocused();
    });
  });
}

test('kill switch off: the same URL loads as two plain legs and offers no add-stop link', async ({ page }) => {
  await page.addInitScript(() => { window.__CH_PLANNER_STOPS_OFF = true; });
  await page.goto(url());
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await expect(page.locator('.add-via')).toHaveCount(0);
  await expect(page.locator('.ins-btn')).toHaveCount(0);
});

test('kill switch off: a 7 h plain leg does not ask and the hand-off carries no ack', async ({ page }) => {
  await page.addInitScript(() => { window.__CH_PLANNER_STOPS_OFF = true; });
  await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo Airport (CMB)|Arugam Bay') + '&pax=2&vehicle=car&ack=0');
  await expect(page.locator('#rail .leg-card')).toHaveCount(1);
  await expect(page.locator('.leg-warn.long-day')).toHaveCount(0);
  await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  expect(new URL(page.url()).searchParams.get('ack')).toBeNull();
});

// The API refuses more than 12 places per trip (MAX_TRIP_STOPS), so the planner stops offering a stop at 12.
test('a trip with 12 places offers no add-stop link; 11 places still does', async ({ page }) => {
  const twelve = ['Kandy', 'Sigiriya / Dambulla', 'Anuradhapura', 'Trincomalee', 'Ella', 'Galle', 'Mirissa', 'Tangalle', 'Nuwara Eliya', 'Negombo', 'Hikkaduwa', 'Colombo'];
  const go = (places) => page.goto('/plan.html?stops=' + encodeURIComponent(places.join('|')) + '&nights=' + places.map(() => 0).join(',') + '&pax=2&vehicle=car');
  await go(twelve);
  await expect(page.locator('#rail .leg-card')).toHaveCount(11);
  await expect(page.locator('.add-via:not([hidden])')).toHaveCount(0);
  await go(twelve.slice(0, 11));
  await expect(page.locator('#rail .leg-card')).toHaveCount(10);
  expect(await page.locator('.add-via:not([hidden])').count()).toBeGreaterThan(0);
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
