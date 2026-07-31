import { test, expect } from '@playwright/test';

// Regression: the ops money-pane line items (.ch-line) once forced `white-space:nowrap` on the
// label, so the long chauffeur "Distance — … (buffered + idle)" label overran the row and the
// money card clipped the amount off the right. The label must wrap; the amount must stay visible.
// Renders the real ops CSS against the real markup structure (offline webServer, no DB).

const OPS_FILE = '/api/src/routes/ops-ui.html';

test('ops money-pane long line label wraps and never clips the amount', async ({ page }) => {
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Inject a money card with the real long chauffeur breakdown line at the pane's inner width.
  const clip = await page.evaluate(() => {
    const qv = document.getElementById('quoteRoot');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:360px;position:fixed;top:60px;left:640px;background:#fff;padding:16px;overflow:hidden';
    wrap.className = 'ch-money-card';
    wrap.innerHTML =
      '<div class="ch-line"><span class="ch-line-label">Chauffeur day rate — 8 day(s)</span><span class="ch-line-val">$280.00</span></div>' +
      '<div class="ch-line" id="probe"><span class="ch-line-label">Distance — 1621 km (1021 buffered travel + 600 idle-day min)</span><span class="ch-line-val" id="probe-val">$567.35</span></div>';
    qv.appendChild(wrap);
    const card = wrap.getBoundingClientRect();
    const val = document.getElementById('probe-val').getBoundingClientRect();
    const label = document.getElementById('probe').querySelector('.ch-line-label').getBoundingClientRect();
    return {
      valVisible: val.right <= card.right + 0.5,   // amount fully inside the card
      labelWrapped: Math.round(label.height) > 22, // wrapped to more than one line
    };
  });

  expect(clip.valVisible, 'amount must be fully inside the card (not clipped)').toBe(true);
  expect(clip.labelWrapped, 'long label should wrap to more than one line').toBe(true);
});

// Regression (owner report 2026-07-31): "Quote LKR total got pulled over to the $ line".
// The LKR figure is a block-level sub-line inside the amount span (.ch-val-sub /
// .ch-total-lkr). runNumberTicks animates the OUTERMOST element matching NUM_TICK_SELECTOR,
// which includes the .ch-line-val CONTAINER — and countTo then wrote el.textContent, which
// replaces every child with one flat text node. That deleted the sub-line span (and its
// display:block), so LKR rendered inline beside the USD, and the .ch-total-usd /
// .ch-total-lkr hooks vanished from the page until the next render rebuilt them.
test('a re-price counts the figures without flattening the LKR sub-line', async ({ page }) => {
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {},
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}),
      },
    };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/places**', (r) => r.fulfill(json({ places: [], suggestions: [] })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
  // Price by km, and carry the LKR strings — those are what render as the sub-lines.
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const km = (b.legs && b.legs[0] && b.legs[0].distanceKm) || 0;
    const cents = km * 50;
    const lkr = 'LKR ' + (cents * 3).toLocaleString('en-US');
    return r.fulfill(json({
      total: { cents, lkr },
      amountDueNow: { cents: Math.round(cents / 10), lkr: 'Rs 0' },
      lineItems: [{ label: 'Colombo → Kandy', amountCents: cents, lkr }],
      breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: [{ priceCents: cents }] },
      fxUsdToLkr: 320, warnings: [],
      services: {
        pointToPoint: { total: { cents, lkr } },
        chauffeur: { error: 'single-day trip — point-to-point only' },
      },
    }));
  });

  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  const from = '.ch-tl-title[data-field="stop"][data-stop="0"]';
  const to = '.ch-tl-title[data-field="stop"][data-stop="1"]';
  await page.locator(from).first().fill('Colombo');
  await page.dispatchEvent(from, 'change');
  await page.locator(to).first().fill('Kandy');
  await page.dispatchEvent(to, 'change');
  // Anchor on the CONTAINER, not .ch-total-usd: the inner spans are exactly what the bug
  // deletes, so waiting on one of them would hang instead of reporting the real failure.
  const totalVal = page.locator('#quoteRoot .ch-total-val');
  await expect(totalVal).toContainText('$60.00', { timeout: 10000 });

  // Watch every value the total passes through, so this test also proves the count still
  // RUNS — a "fix" that quietly stopped animating would satisfy the span assertions below.
  await page.evaluate(() => {
    window.__seen = [];
    const host = document.querySelector('#quoteRoot .ch-money');
    new MutationObserver(() => {
      const t = document.querySelector('#quoteRoot .ch-total-val');
      if (t) window.__seen.push(t.textContent.trim());
    }).observe(host, { subtree: true, characterData: true, childList: true });
  });

  // Change the distance so every money figure moves — this is the render that ticks.
  await page.locator('[data-action="manualDistance"]').first().click();
  const kmBox = page.locator('[data-field="distanceKm"]').first();
  await expect(kmBox).toBeVisible({ timeout: 5000 });
  await kmBox.fill('300');
  await page.dispatchEvent('[data-field="distanceKm"]', 'change');
  await expect(totalVal).toContainText('$150.00', { timeout: 10000 });
  await page.waitForTimeout(900); // let the 420ms count + its landing settle

  // The sub-line spans must have survived the count, in the total AND the line item.
  await expect(page.locator('#quoteRoot .ch-total-usd')).toHaveCount(1);
  await expect(page.locator('#quoteRoot .ch-total-lkr')).toHaveCount(1);
  const shape = await page.evaluate(() => {
    const totalVal = document.querySelector('#quoteRoot .ch-total-val');
    const item = [...document.querySelectorAll('#quoteRoot .ch-line-val')]
      .find((el) => !el.classList.contains('ch-total-val'));
    const usd = document.querySelector('#quoteRoot .ch-total-usd');
    const lkr = document.querySelector('#quoteRoot .ch-total-lkr');
    return {
      totalChildEls: totalVal ? totalVal.children.length : -1,
      itemSubSpans: item ? item.querySelectorAll('.ch-val-sub').length : -1,
      // display:block puts LKR on its own row — its top must clear the USD's.
      lkrBelowUsd: usd && lkr ? lkr.getBoundingClientRect().top >= usd.getBoundingClientRect().bottom - 1 : null,
    };
  });
  expect(shape.totalChildEls, 'total keeps its USD + LKR spans').toBe(2);
  expect(shape.itemSubSpans, 'line item keeps its LKR sub-line span').toBe(1);
  // The figures counted UP through intermediate values rather than snapping $60 → $150.
  const midway = await page.evaluate(() => (window.__seen || []).some((s) => {
    const m = s.match(/\$(\d+(?:\.\d+)?)/);
    return m && Number(m[1]) > 60 && Number(m[1]) < 150;
  }));
  expect(midway, 'the total counts through intermediate values (tick still runs)').toBe(true);
  expect(shape.lkrBelowUsd, 'LKR renders below the USD, not pulled onto its line').toBe(true);
});
