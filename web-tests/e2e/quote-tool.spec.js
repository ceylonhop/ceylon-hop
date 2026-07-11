import { test, expect } from '@playwright/test';

// The internal quoting tool is a view mounted inside the ops dashboard
// (api/src/routes/ops-ui.html), not a standalone page — the old /admin/quote
// shell was retired (it 302s to /ops now). Per spec D-A, quote:manage (and so
// the Quote nav) is granted to all 3 human roles (founder/finance/ops), not
// founder-only — these specs still drive the tool as founder since that's the
// superset role and none of the assertions here are role-gating checks (those
// live in ops-ui.spec.js). These specs need a real DATABASE_URL — they only run
// with CH_E2E_API=1 (see playwright.config.js and package.json's "test:e2e:tool"
// script), and need OPS_USERS (allowlisting founder@e2e.test) set on the booted
// API (playwright.config.js's webServer.env supplies a dev default). Login goes
// through the dev-login bypass (#devloginemail/#devloginform) since Google
// Sign-In needs a real OAuth client and can't be driven in e2e.
test.skip(process.env.CH_E2E_API !== '1', 'quote-tool e2e needs the API — run with CH_E2E_API=1');

const OPS = 'http://localhost:8787/ops';

// Matches playwright.config.js's OPS_USERS default for the CH_E2E_API webServer.
const FOUNDER_EMAIL = 'founder@e2e.test';

// Helper: log in to /ops as founder (via the dev-login bypass) and open the
// Quote view. Every spec starts here instead of goto'ing the old standalone
// /admin/quote page.
async function loginFounderAndOpenQuote(page) {
  await page.goto(OPS);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.fill('#devloginemail', FOUNDER_EMAIL);
  await page.evaluate(() => document.getElementById('devloginform').requestSubmit());
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  // App shell becomes visible post-login (Bookings renders first).
  await expect(page.locator('#approot')).toBeVisible({ timeout: 10000 });
  // Merged surface: open the Quotes queue, then start a fresh quote to mount the builder.
  await page.locator('#nav button[data-route="quotes"]').click();
  await page.locator('#view [data-qnew]').click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
}

// Helper: pick a place from the live autocomplete menu for a leg's from/to field.
async function pickPlace(page, input, query, resultText) {
  await input.click();
  await page.keyboard.type(query, { delay: 40 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  const item = page.locator('.ch-ac-menu .ch-ac-item', { hasText: resultText }).first();
  await expect(item).toContainText('Popular Route');
  await item.click();
}

// Helper: read the strong (total) line's PRIMARY value (USD). The value element also
// carries a small LKR reference sub-span, so strip everything from 'LKR' onward.
async function totalLineText(page) {
  const raw = await page.locator('.ch-line.strong .ch-line-val').first().textContent();
  return raw.split('LKR')[0].trim();
}

// The /estimate route 400s on a leg date that's present-but-not-YYYY-MM-DD, and the client
// always sends `leg.date || ''` — so a leg with no date at all fails validation too. Every
// spec that expects a priced estimate must fill a date on each leg it prices.
async function fillFirstLegDate(page, iso) {
  await page.locator('input[type="date"][data-field="date"]').first().fill(iso);
}

// Fix 1: there is no default vehicle anymore — ops must choose one before any
// estimate is priced. Every spec that expects a priced summary must call this
// right after opening the quote view.
async function chooseVehicle(page, value) {
  // Vehicle is a chip row in the Trip basics section (with the customer fields) and gates the
  // itinerary — picking it here unlocks the leg rows.
  await page.locator('[data-action="setVehicle"][data-veh="' + value + '"]').click();
  // Choosing a vehicle kicks off a debounced estimate that render()s ~350ms later,
  // replacing #app wholesale. Let that settle before the spec starts typing into
  // leg inputs, or the re-render wipes the input node mid-keystroke.
  await page.waitForTimeout(600);
}

test.beforeEach(async ({ page }) => {
  await loginFounderAndOpenQuote(page);
  // The itinerary is gated until the trip basics are filled — vehicle + name + a valid contact —
  // so every spec's leg interactions have rows to work with. Specs that need another tier call
  // chooseVehicle again.
  await chooseVehicle(page, 'car');
  await page.fill('#f-customerName', 'Test Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
});

// Spec 1: Timeline autocomplete → auto-distance → priced summary → save
test('timeline autocomplete → priced LKR summary → save reference toast', async ({ page }) => {
  await chooseVehicle(page, 'van_6');

  // Fill first leg: "From" field (first .ch-tl-title with data-field="pickupLocation")
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');

  // Fill second leg: "Destination" field (first .ch-tl-title with data-field="dropoffLocation")
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  // A date is required — the API rejects an empty-string date on any leg.
  await fillFirstLegDate(page, '2026-08-01');

  // Wait for auto-distance to resolve and estimate to populate
  // The km hero tile and the quote total line should appear
  await expect(page.locator('.ch-km.hero')).toBeVisible({ timeout: 8000 });
  const heroText = await page.locator('.ch-km.hero b').textContent();
  expect(heroText).not.toBe('0');

  // Quote total (strong line) should contain LKR
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });

  // Fill customer name — text fields only update state on 'input' (no
  // change→render race with the Save action), so no Tab/blur workaround is needed.
  const nameInput = page.locator('#f-customerName');
  await nameInput.fill('E2E Port');

  // Save via the action-bar button. The old standalone-builder #btnSave header button was
  // retired when the builder merged into the ops shell; Save is now a `.ch-btn` in the
  // maker-checker action bar rendered as data-action="saveDraft" (a founder draft shows
  // [Approve — ready to send] + [Save]).
  await page.locator('[data-action="saveDraft"]').click();

  // Toast should appear containing the reference (starts with Q-)
  const toastMsg = page.locator('.ch-toast-msg');
  await expect(toastMsg).toContainText('Q-', { timeout: 8000 });
});

test('ops autocomplete shows pending search and stays closed after scroll', async ({ page }) => {
  await chooseVehicle(page, 'van_6');

  let delayedPlaces = 0;
  await page.route('**/admin/quote/places?q=Kitulgala', async (route) => {
    delayedPlaces += 1;
    await new Promise((resolve) => setTimeout(resolve, 550));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        places: ['Kitulgala'],
        suggestions: [{ label: 'Kitulgala', source: 'known' }],
      }),
    });
  });

  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await toInput.click();
  await toInput.fill('Kitulgala');

  await expect(page.locator('.ch-ac-menu .ch-ac-item.loading')).toContainText('Searching Google');
  await page.mouse.wheel(0, 300);
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);

  await page.waitForTimeout(700);
  expect(delayedPlaces).toBeGreaterThan(0);
  await expect(toInput).toHaveValue('Kitulgala');
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);
});

test('autocomplete stays closed after picking a place (does not reopen on re-render)', async ({ page }) => {
  // Regression: after acPick, acClose cleared _ac.committed, so restoreEditorFocus (which runs
  // on every render and refocuses the picked field) re-fired requestAutocomplete for the
  // committed value — reopening the dropdown once per follow-up auto-distance/estimate render
  // ("autocomplete pops out multiple times even after choosing an item").
  await chooseVehicle(page, 'van_6');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');

  // The menu closes on pick…
  await expect(fromInput).toHaveValue('Kandy');
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);

  // …and STAYS closed while the follow-up re-renders land (each refocuses this field).
  await page.waitForTimeout(800);
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);
});

// Spec 2: Car + 4 bags triggers the luggage flag
test('car + 4 bags raises the luggage flag', async ({ page }) => {
  // Select Car via the money-pane vehicle chips
  await chooseVehicle(page, 'car');

  // Set bags to 4
  const bagsInput = page.locator('#f-luggageCount');
  await bagsInput.fill('4');
  await bagsInput.dispatchEvent('change');

  // A flag with "luggage" (case-insensitive) should be visible
  await expect(
    page.locator('.ch-flag', { hasText: /luggage/i }).first()
  ).toBeVisible({ timeout: 5000 });
});

// Spec 3 (V1 + reflow): a chauffeur trip (chosen via the service chooser) that spans a REST
// (idle) day. The per-leg "stay day" was retired — idle days now derive from a gap in the leg
// dates and are folded into the chauffeur PRICING (the day rate spans the gap + idle-day km),
// so the customer message no longer lists an unpriced "Stay in …" line. This spec asserts the
// current shape: the rest day is charged (not dropped, not shown as a separate itinerary line),
// the LAST transfer's row survives (the old alignment bug dropped it), the full-payment line
// is present, and the message total matches the Summary card.
test('chauffeur trip spanning a rest day: idle day priced, last leg kept, full-payment line (V1)', async ({ page }) => {
  await chooseVehicle(page, 'van_6');

  // Leg 1 (transfer): Kandy → Ella, Aug 1. (Settle waits: render() replaces #app
  // wholesale ~350ms after each mutation; see the app's debounce.)
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await page.locator('input[type="date"][data-field="date"]').first().fill('2026-08-01');
  await page.waitForTimeout(600);

  // Leg 2 (transfer): Ella → Galle, Aug 3 — the Aug-2 gap is the idle/rest day (an idle day
  // derived from the date span, not an explicit stay leg).
  await page.locator('[data-action="addLeg"][data-cat="transfer"]').click();
  await expect(page.locator('.ch-tl-item')).toHaveCount(2);
  await page.locator('input[type="date"][data-field="date"]').nth(1).fill('2026-08-03');
  await page.waitForTimeout(600);
  const secondTo = page.locator('.ch-tl-item').nth(1).locator('.ch-tl-title[data-field="dropoffLocation"]');
  await pickPlace(page, secondTo, 'Galle', 'Galle');
  await page.waitForTimeout(600);

  // Leg 3 (transfer): Galle → Mirissa, Aug 4.
  await page.locator('[data-action="addLeg"][data-cat="transfer"]').click();
  await expect(page.locator('.ch-tl-item')).toHaveCount(3);
  await page.locator('input[type="date"][data-field="date"]').nth(2).fill('2026-08-04');
  await page.waitForTimeout(600);
  const thirdTo = page.locator('.ch-tl-item').nth(2).locator('.ch-tl-title[data-field="dropoffLocation"]');
  await pickPlace(page, thirdTo, 'Miri', 'Mirissa');
  await page.waitForTimeout(600);

  // Choose Chauffeur-guide via the service chooser (all legs dated, 3 distinct dates → enabled).
  const chBtn = page.locator('[data-action="setService"][data-service="chauffeur"]');
  await expect(chBtn).toBeEnabled({ timeout: 10000 });
  await chBtn.click();
  await page.waitForTimeout(600);

  // (The Travel|Stay per-leg switch was retired — the Aug-1→Aug-3→Aug-4 span carries one idle
  // day between legs 1 and 2, which the engine prices as an extra chauffeur day + idle km.)

  // Priced chauffeur summary.
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 10000 });
  // The customer message is gated behind approval now (commit c268d13): while the quote is a
  // draft the WhatsApp/Email body is replaced by a `.ch-copy-lock` card, so `.ch-pre` is
  // hidden (copyUnlocked() → status==='ready'||'sent'). Approve it first — approveReady()
  // saves, PATCHes status→ready, and bounces to the Quotes queue — then reopen the quote from
  // the queue (which re-prices it) and read the now-unlocked message.
  const custName = 'E2E Stay ' + Date.now();
  await page.locator('#f-customerName').fill(custName);
  await page.locator('[data-action="approveReady"]').click();

  // Landed back on the Quotes queue — clicking a row reopens that quote in the builder.
  const qrow = page.locator('#view .qrow', { hasText: custName });
  await expect(qrow).toBeVisible({ timeout: 8000 });
  await qrow.click();
  await expect(page.locator('.ch-toast-msg')).toContainText('Reopened', { timeout: 8000 });

  // Re-priced on reopen — read the summary total from the reopened builder so the WhatsApp
  // total is compared against the same render.
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 10000 });
  const summaryTotal = await totalLineText(page);

  // WhatsApp output checks. The output panel lives at the foot of the money card.
  // On the two-pane (≥960px) layout it's OPEN by default; when stacked it's
  // collapsed. Ensure it's open (only toggle if the panel isn't already showing)
  // so this spec is robust to the viewport-driven default.
  const outPanel = page.locator('.ch-out-panel');
  if (!(await outPanel.isVisible().catch(() => false))) {
    await page.locator('[data-action="toggleOutput"]').click();
  }
  await page.locator('[data-action="setTab"][data-tab="whatsapp"]').click();
  // Copy is unlocked now the quote is Ready, so the customer message renders as `.ch-pre`
  // instead of the `.ch-copy-lock` card.
  const pre = page.locator('.ch-output-body .ch-pre');
  await expect(pre).toBeVisible({ timeout: 8000 });
  const waText = await pre.textContent();

  // The idle/rest day is folded into the chauffeur pricing, not shown as a separate itinerary
  // line: the day rate spans the 4-day window (Aug 1→4) and the distance line carries non-zero
  // idle-day km. There is no unpriced "Stay in …" line anymore (the per-leg stay day is gone).
  expect(waText, waText).not.toMatch(/Stay in/); // no explicit stay-day itinerary line anymore
  expect(waText).toMatch(/4 day\(s\)/); // rest day IS charged — day rate spans the Aug 1→4 window
  expect(waText).toMatch(/[1-9]\d* idle-day min/); // …and the idle day adds non-zero idle km
  expect(waText).toContain('Mirissa'); // the transfer AFTER the gap is not dropped (old V1 bug)
  expect(waText).toMatch(/Pay in full to confirm/); // chauffeur full-payment line
  expect(waText).toContain(summaryTotal.trim()); // message total matches the Summary card
});

// Spec 3b (reflow): the service chooser gates chauffeur and the per-leg add-ons.
test('service chooser: chauffeur gated by dates, add-ons only in point-to-point', async ({ page }) => {
  await chooseVehicle(page, 'van_6');

  // Undated single leg → chauffeur disabled.
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  const chBtn = page.locator('[data-action="setService"][data-service="chauffeur"]');
  await expect(chBtn).toBeDisabled();

  // Point-to-point (default): the per-leg add-on control exists. In the cockpit
  // layout the sightseeing/waiting/safari checkboxes live behind a per-leg popover
  // (the ⧉ add-on button); open it, then the toggles are attached.
  await expect(page.locator('[data-action="toggleAddons"]').first()).toBeAttached();
  await page.locator('[data-action="toggleAddons"]').first().click();
  await expect(page.locator('input[data-field="addSightseeingFee"]').first()).toBeAttached();
  await expect(page.locator('input[data-field="addSafariWait"]').first()).toBeAttached();
  // Close the popover again so the later re-renders start clean.
  await page.locator('[data-action="toggleAddons"]').first().click();

  // Date both ends across two days → chauffeur becomes enabled and shows a price.
  await page.locator('input[type="date"][data-field="date"]').first().fill('2026-08-01');
  await page.waitForTimeout(600);
  await page.locator('[data-action="addLeg"][data-cat="transfer"]').click();
  await page.locator('input[type="date"][data-field="date"]').nth(1).fill('2026-08-02');
  await page.waitForTimeout(600);
  const secondTo = page.locator('.ch-tl-item').nth(1).locator('.ch-tl-title[data-field="dropoffLocation"]');
  await pickPlace(page, secondTo, 'Galle', 'Galle');
  await expect(chBtn).toBeEnabled({ timeout: 10000 });
  await expect(chBtn).toContainText('LKR', { timeout: 10000 }); // side-by-side price on the option

  // Choose chauffeur → add-on control disappears entirely (no popover button either), caption shows.
  // (The "Add stay day" button was retired — chauffeur idle days derive from the leg dates.)
  await chBtn.click();
  await page.waitForTimeout(600);
  await expect(page.locator('input[data-field="addSightseeingFee"]')).toHaveCount(0);
  await expect(page.locator('[data-action="toggleAddons"]')).toHaveCount(0);
  await expect(page.locator('.ch-svc-caption')).toContainText(/included/i);
  await expect(page.locator('[data-action="addLeg"][data-cat="stay_day"]')).toHaveCount(0); // no stay-day button anymore

  // Back to point-to-point → per-leg add-on control returns.
  await page.locator('[data-action="setService"][data-service="private"]').click();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-action="toggleAddons"]').first()).toBeAttached();
});

// Spec 4 (V5): maker-checker status sync. The old per-status `#statusSelect` dropdown was
// retired — a quote's status now moves only through the maker-checker actions (Submit for
// review / Approve — ready to send), and transition() PATCHes the new status then bounces to
// the queue. This is the successor of the old "status chosen on save is reflected in the
// list": a founder approving a draft persists status=ready and the queue row shows the
// "Ready to send" pill.
test('approving a draft syncs status=ready to the queue (V5)', async ({ page }) => {
  await chooseVehicle(page, 'van_6');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await fillFirstLegDate(page, '2026-08-01');
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });

  // Unique customer name so we can find the row unambiguously
  const custName = 'E2E Status ' + Date.now();
  await page.locator('#f-customerName').fill(custName);

  // Founder self-approves the draft in one hop: approveReady() saves, PATCHes status→ready,
  // and navigates back to the queue.
  await page.locator('[data-action="approveReady"]').click();

  // On the queue, this quote's row shows the Ready pill (QSTATUS.ready.label = 'Ready to send').
  const row = page.locator('#view .qrow', { hasText: custName });
  await expect(row).toBeVisible({ timeout: 8000 });
  await expect(row.locator('.qpill')).toContainText(/Ready to send/i);
});

// Spec 5 (V19): Reopen — the standalone-builder Recent drawer (#btnRecent/.ch-recent-row)
// was retired when the builder merged into the ops shell; the Quotes queue IS the list now.
// Clicking a queue row (.qrow) reopens the saved quote and repopulates the customer name.
test('clicking a queue row reopens the saved quote (V19)', async ({ page }) => {
  await chooseVehicle(page, 'van_6');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await fillFirstLegDate(page, '2026-08-01');
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });

  const custName = 'E2E Reopen ' + Date.now();
  await page.locator('#f-customerName').fill(custName);
  await page.locator('[data-action="saveDraft"]').click();
  await expect(page.locator('.ch-toast-msg')).toContainText('Saved as', { timeout: 8000 });

  // Start a fresh quote so we can prove the reopen repopulates the name. "+ New quote" lives
  // in the queue now (data-qnew), so go there and start a blank quote — no unsaved-changes
  // confirm fires because the save above cleared the dirty flag.
  await page.locator('#nav button[data-route="quotes"]').click();
  await page.locator('#view [data-qnew]').click();
  await expect(page.locator('#f-customerName')).toHaveValue('');

  // Back to the queue and click this quote's row to reopen it.
  await page.locator('#nav button[data-route="quotes"]').click();
  const row = page.locator('#view .qrow', { hasText: custName });
  await expect(row).toBeVisible({ timeout: 8000 });
  await row.click();

  await expect(page.locator('.ch-toast-msg')).toContainText('Reopened', { timeout: 8000 });
  await expect(page.locator('#f-customerName')).toHaveValue(custName);
});

// Spec 6 (Fix 4 + Fix 5): reordering legs, and the out-of-order-dates flag.
test('legs can be reordered and out-of-order dates raise a flag', async ({ page }) => {
  await chooseVehicle(page, 'van_6');

  const outOfOrderFlag = page.locator('.ch-flag', { hasText: /Dates out of order/i });

  // Leg 1, dated first.
  await page.locator('input[type="date"][data-field="date"]').first().fill('2026-08-01');
  await page.waitForTimeout(400);

  // Add leg 2, dated LATER — dates are in order, so no flag.
  await page.locator('[data-action="addLeg"][data-cat="transfer"]').click();
  await expect(page.locator('.ch-tl-item')).toHaveCount(2);
  await page.locator('input[type="date"][data-field="date"]').nth(1).fill('2026-08-05');
  await page.waitForTimeout(400);
  await expect(outOfOrderFlag).toHaveCount(0);

  // Swap the dates so leg 1 is LATER than leg 2 → flag appears.
  await page.locator('input[type="date"][data-field="date"]').first().fill('2026-08-10');
  await page.waitForTimeout(400);
  await expect(outOfOrderFlag.first()).toBeVisible({ timeout: 5000 });

  // Move leg 2 up (now dates read 2026-08-05 then 2026-08-10) → linear again, flag clears.
  await page.locator('.ch-tl-item').nth(1).locator('[data-action="moveLegUp"]').click();
  await page.waitForTimeout(400);
  await expect(outOfOrderFlag).toHaveCount(0);
});

// Spec 7: the queue shows an age-since-request chip on each row, coloured for urgency. A
// freshly-saved quote is <1h old, so its chip renders with the calm "fresh" tone (not amber/red).
test('queue row shows a fresh age chip for a just-saved quote', async ({ page }) => {
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await fillFirstLegDate(page, '2026-08-01');

  const custName = 'E2E Age ' + Date.now();
  await page.locator('#f-customerName').fill(custName);
  await page.locator('[data-action="saveDraft"]').click();
  await expect(page.locator('.ch-toast-msg')).toContainText('Saved as', { timeout: 8000 });

  // Back to the queue; the row for this quote carries a `.qage` chip, calm tone (just created).
  await page.locator('#nav button[data-route="quotes"]').click();
  const row = page.locator('#view .qrow', { hasText: custName });
  await expect(row).toBeVisible({ timeout: 8000 });
  const age = row.locator('.qage');
  await expect(age).toBeVisible();
  await expect(age).toHaveClass(/tone-fresh/);
});

// Spec 8 (regression, user-reported): reopening a saved quote marks its legs manual-distance
// (to preserve the saved price). Previously that froze the price when you changed a location on
// a reopened quote — auto-distance bailed on the manual flag. Changing the destination must now
// drop the manual distance and re-price for the new route.
test('changing a reopened quote destination re-prices it', async ({ page }) => {
  // Build + save a Kandy → Ella car quote (distance auto-resolves; price is set).
  await chooseVehicle(page, 'car');
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await fillFirstLegDate(page, '2026-08-01');
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });
  const custName = 'E2E Reprice ' + Date.now();
  await page.locator('#f-customerName').fill(custName);
  await page.locator('[data-action="saveDraft"]').click();
  await expect(page.locator('.ch-toast-msg')).toContainText('Saved as', { timeout: 8000 });

  // Reopen it from the queue — reopened legs come back in manual-distance mode.
  await page.locator('#nav button[data-route="quotes"]').click();
  const row = page.locator('#view .qrow', { hasText: custName });
  await expect(row).toBeVisible({ timeout: 8000 });
  await row.click();
  await expect(page.locator('.ch-toast-msg')).toContainText('Reopened', { timeout: 8000 });
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 10000 });
  const totalElla = await totalLineText(page);

  // Change the destination to a much farther place (clear it, then pick Mirissa). The price
  // MUST recompute — previously the reopened leg's frozen manual distance kept it unchanged.
  const toReopened = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await toReopened.fill('');
  await pickPlace(page, toReopened, 'Miri', 'Mirissa');
  await expect
    .poll(async () => { try { return await totalLineText(page); } catch (e) { return totalElla; } },
      { timeout: 10000, message: 'reopened quote should re-price after changing the destination' })
    .not.toBe(totalElla);
});

// Spec 9 (regression, user-reported): reducing a chauffeur trip to a single day (e.g. deleting
// legs on a reopened chauffeur quote) must auto-revert the service to point-to-point. Chauffeur
// is invalid single-day, so the quote must DROP the day rate instead of keeping it on a single
// transfer.
test('reducing a chauffeur trip to one day reverts to point-to-point (drops the day rate)', async ({ page }) => {
  await chooseVehicle(page, 'van_6');
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await page.locator('input[type="date"][data-field="date"]').first().fill('2026-08-01');
  await page.waitForTimeout(600);

  // Leg 2 on a second date → two distinct dates → chauffeur becomes eligible.
  await page.locator('[data-action="addLeg"][data-cat="transfer"]').click();
  await expect(page.locator('.ch-tl-item')).toHaveCount(2);
  await page.locator('input[type="date"][data-field="date"]').nth(1).fill('2026-08-02');
  await page.waitForTimeout(600);
  const secondTo = page.locator('.ch-tl-item').nth(1).locator('.ch-tl-title[data-field="dropoffLocation"]');
  await pickPlace(page, secondTo, 'Galle', 'Galle');
  await page.waitForTimeout(600);

  // Choose chauffeur — the summary now carries a day rate.
  const chBtn = page.locator('[data-action="setService"][data-service="chauffeur"]');
  await expect(chBtn).toBeEnabled({ timeout: 10000 });
  await chBtn.click();
  await expect(page.locator('#quoteRoot')).toContainText('Chauffeur day rate', { timeout: 10000 });

  // Delete leg 2 → single leg / single date → chauffeur ineligible. Service must auto-revert to
  // point-to-point, so the chauffeur day rate disappears from the quote.
  await page.locator('.ch-tl-item').nth(1).locator('[data-action="removeLeg"]').click();
  await expect(page.locator('.ch-tl-item')).toHaveCount(1);
  await expect(page.locator('#quoteRoot')).not.toContainText('Chauffeur day rate', { timeout: 8000 });
});
