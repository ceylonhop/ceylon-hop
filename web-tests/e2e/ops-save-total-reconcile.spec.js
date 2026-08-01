import { test, expect } from '@playwright/test';

// The builder prices only its READY legs while one still has no distance (Defect A partial
// pricing, "Covers the ready legs"), but /save sends the FULL itinerary and the server resolves
// the rest. Nothing reconciled the two, so the operator could save at a price they never saw —
// measured $75.00 on screen against $266.00 stored. /save now echoes what it resolved and what
// it charged, and the builder adopts it and re-prices.
// Offline: the API is stubbed, with a distance endpoint that is deliberately BLIND to one place
// (mirroring a Maps miss the operator can't fix) while the "server" side still resolves it.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const CLIENT_BLIND = 'Sigiriya';
const KM = (from, to) => {
  let h = 7;
  for (const ch of String(from) + '>' + String(to)) h = (h * 131 + ch.charCodeAt(0)) >>> 0;
  return 20 + (h % 300);
};

function priceOf(legs) {
  const bLegs = [];
  let total = 0;
  for (const l of legs) {
    if (l.category === 'stay_day') continue;
    const km = Number(l.distanceKm) || 0;
    total += km * 100;
    bLegs.push({ priceCents: km * 100, distanceKm: km });
  }
  const lkr = 'LKR ' + (total * 3).toLocaleString('en-US');
  return {
    total: { cents: total, lkr },
    amountDueNow: { cents: Math.round(total / 10), lkr: 'Rs 0' },
    lineItems: [{ label: 'Travel', amountCents: total, lkr }],
    breakdown: { km: { distanceKm: 0, bufferKm: 0, billableKm: 0 }, legs: bLegs },
    fxUsdToLkr: 320, warnings: [],
    services: { pointToPoint: { total: { cents: total, lkr } }, chauffeur: { error: 'single-day trip — point-to-point only' } },
  };
}

async function stubOps(page, rec) {
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
  const json = (o, s = 200) => ({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage', 'margin:view'] })));
  await page.route('**/admin/ops/bookings**', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/quote/places**', (r) => r.fulfill(json({ places: [], suggestions: [] })));

  // The CLIENT's lookup cannot resolve CLIENT_BLIND.
  await page.route('**/admin/quote/distance', (r) => {
    const b = r.request().postDataJSON() || {};
    if (String(b.from).includes(CLIENT_BLIND) || String(b.to).includes(CLIENT_BLIND)) return r.fulfill(json({ error: 'not_found' }, 404));
    return r.fulfill(json({ km: KM(b.from, b.to), durationMin: 60 }));
  });

  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    rec.estimate.push(b);
    return r.fulfill(json(priceOf(b.legs || [])));
  });

  // The SERVER resolves every missing distance (resolveAndPrice) and now echoes what it
  // resolved plus what it charged.
  await page.route('**/admin/quote/save', (r) => {
    const b = r.request().postDataJSON() || {};
    const legs = JSON.parse(JSON.stringify(b.legs || []));
    for (const l of legs) {
      if (l.category === 'stay_day') continue;
      if (l.stops) {
        const segs = l.segmentKms || new Array(l.stops.length - 1).fill(null);
        for (let i = 0; i < l.stops.length - 1; i++) if (segs[i] == null || segs[i] <= 0) segs[i] = KM(l.stops[i], l.stops[i + 1]);
        l.segmentKms = segs;
        l.distanceKm = segs.reduce((a, c) => a + c, 0);
      } else if (!l.distanceKm || l.distanceKm <= 0) l.distanceKm = KM(l.from, l.to);
    }
    const priced = priceOf(legs);
    rec.storedTotalCents = priced.total.cents;
    return r.fulfill(json({
      id: 'q_probe', reference: 'Q-PROBE', status: 'draft', assignedTo: 'f@e2e.test',
      totalCents: priced.total.cents,
      legs: legs.map((l) => ({ distanceKm: l.distanceKm ?? null, segmentKms: l.segmentKms ?? null })),
    }));
  });
}

async function setStop(page, li, si, v) {
  await page.evaluate(({ li, si, v }) => {
    const inp = document.querySelectorAll('#quoteRoot .ch-app .ch-leg')[li].querySelector(`[data-field="stop"][data-stop="${si}"]`);
    inp.focus(); inp.value = v;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, { li, si, v });
  await page.waitForTimeout(250);
}

test('saving reconciles the builder to the total that was actually stored', async ({ page }) => {
  const rec = { estimate: [], storedTotalCents: 0 };
  await stubOps(page, rec);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 15000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').dispatchEvent('click');
  for (const [id, v] of [['f-firstName', 'Probe'], ['f-lastName', 'Owner'], ['f-contact', '+94770000000']]) {
    await page.evaluate(({ id, v }) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, { id, v });
  }
  await setStop(page, 0, 0, 'Colombo');
  await setStop(page, 0, 1, 'Kandy');
  await page.waitForTimeout(1600);

  // A second leg whose distance the CLIENT cannot resolve — the total goes partial.
  await page.locator('[data-action="addLeg"]').first().dispatchEvent('click');
  await page.waitForTimeout(400);
  await setStop(page, 1, 1, CLIENT_BLIND);
  await page.waitForTimeout(1800);

  const totalVal = page.locator('#quoteRoot .ch-total-val');
  const partial = (await totalVal.textContent()).trim();
  await expect(page.locator('#quoteRoot .ch-partial-note')).toBeVisible();
  expect(partial).toContain('$' + (KM('Colombo', 'Kandy')).toFixed(2)); // leg 1 only

  // Save. The server prices BOTH legs; the builder must land on that number.
  await page.locator('[data-action="saveDraft"]').dispatchEvent('click');
  await page.waitForTimeout(2500);

  const expectedTotal = (KM('Colombo', 'Kandy') + KM('Kandy', CLIENT_BLIND)) * 100;
  expect(rec.storedTotalCents).toBe(expectedTotal);
  const shown = (await totalVal.textContent()).trim();
  expect(shown, 'the builder shows the total that was stored, not its partial one').toContain('$' + (expectedTotal / 100).toFixed(2));
  await expect(page.locator('#quoteRoot .ch-partial-note')).toHaveCount(0);

  // The adopted distance is on the leg, and the last estimate priced both legs.
  const lastLegs = (rec.estimate.at(-1) || {}).legs || [];
  expect(lastLegs).toHaveLength(2);
  expect(Number(lastLegs[1].distanceKm)).toBe(KM('Kandy', CLIENT_BLIND));

  // Adoption must not leave the quote looking unsaved — that would re-arm autosave every save.
  const chip = await page.evaluate(() => (document.getElementById('ch-savestate') || {}).textContent || '');
  expect(chip.toLowerCase(), 'adoption must not mark the quote dirty').not.toContain('unsaved');
  expect(chip.toLowerCase()).not.toContain('edits pending');
});
