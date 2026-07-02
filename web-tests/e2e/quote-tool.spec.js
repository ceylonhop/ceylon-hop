import { test, expect } from '@playwright/test';

// The internal quoting tool is served by the API (not the static site) and
// needs a real DATABASE_URL — these specs only run with CH_E2E_API=1 (see
// playwright.config.js and package.json's "test:e2e:tool" script).
test.skip(process.env.CH_E2E_API !== '1', 'quote-tool e2e needs the API — run with CH_E2E_API=1');

const TOOL = 'http://localhost:8787/admin/quote';

// Helper: pick a place from the live autocomplete menu for a leg's from/to field.
async function pickPlace(page, input, query, resultText) {
  await input.click();
  await page.keyboard.type(query, { delay: 40 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: resultText }).first().click();
}

// Helper: read the strong (total) line's value text.
async function totalLineText(page) {
  return page.locator('.ch-line.strong .ch-line-val').first().textContent();
}

// The /estimate route 400s on a leg date that's present-but-not-YYYY-MM-DD, and the client
// always sends `leg.date || ''` — so a leg with no date at all fails validation too. Every
// spec that expects a priced estimate must fill a date on each leg it prices.
async function fillFirstLegDate(page, iso) {
  await page.locator('input[type="date"][data-field="date"]').first().fill(iso);
}

// Spec 1: Timeline autocomplete → auto-distance → priced summary → save
test('timeline autocomplete → priced LKR summary → save reference toast', async ({ page }) => {
  await page.goto(TOOL);
  // Wait for the page to fully initialise (rate card fetch + render complete)
  await page.waitForLoadState('networkidle');

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
  // change→render race with #btnSave), so no Tab/blur workaround is needed.
  const nameInput = page.locator('#f-customerName');
  await nameInput.fill('E2E Port');

  // Click header Save button
  await page.locator('#btnSave').click();

  // Toast should appear containing the reference (starts with Q-)
  const toastMsg = page.locator('.ch-toast-msg');
  await expect(toastMsg).toContainText('Q-', { timeout: 8000 });
});

// Spec 2: Car + 4 bags triggers the luggage flag
test('car + 4 bags raises the luggage flag', async ({ page }) => {
  await page.goto(TOOL);
  await page.waitForLoadState('networkidle');

  // Select Car in the vehicle dropdown
  const vehicleSel = page.locator('#f-vehicleType');
  await vehicleSel.selectOption('car');

  // Set bags to 4
  const bagsInput = page.locator('#f-luggageCount');
  await bagsInput.fill('4');
  await bagsInput.dispatchEvent('change');

  // A flag with "luggage" (case-insensitive) should be visible
  await expect(
    page.locator('.ch-flag', { hasText: /luggage/i }).first()
  ).toBeVisible({ timeout: 5000 });
});

// Spec 3 (V1): Stay-day alignment — a chauffeur trip's WhatsApp output must show
// the stay-in line WITHOUT a price, plus a deposit line, and the total must match
// the Summary card's total.
test('stay day renders unpriced in WhatsApp output with deposit line (V1)', async ({ page }) => {
  await page.goto(TOOL);
  await page.waitForLoadState('networkidle');

  // Leg 1 (transfer): Kandy → Ella
  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  // Give leg 1 a date and mark driver+car as staying (chauffeur product)
  await page.locator('input[type="date"][data-field="date"]').first().fill('2026-08-01');
  await page.locator('[data-action="toggleDriver"]').first().click();
  await page.locator('[data-action="toggleCarStay"]').first().click();
  // Let the auto-distance/estimate background renders triggered above settle before the
  // next step — render() replaces #app wholesale (debounced ~350ms after the last
  // mutation), which would otherwise wipe an autocomplete menu opened mid-flight
  // against a stale DOM node. networkidle doesn't cover the pre-network debounce
  // window, so a short bounded settle wait is used instead (matches the app's own
  // 350ms debounce).
  await page.waitForTimeout(600);

  // Add a stay day (inherits dropoff from previous leg = Ella)
  await page.locator('[data-action="addLeg"][data-cat="stay_day"]').click();
  const stayDateInputs = page.locator('input[type="date"][data-field="date"]');
  await expect(stayDateInputs).toHaveCount(2);
  await stayDateInputs.nth(1).fill('2026-08-02');
  await page.waitForTimeout(600);

  // Add a third leg (transfer): Ella → Galle. Fill its date FIRST (every leg needs a
  // valid date or /estimate 400s) so the background estimate settles before we type
  // into the autocomplete field.
  await page.locator('[data-action="addLeg"][data-cat="transfer"]').click();
  const legItems = page.locator('.ch-tl-item');
  await expect(legItems).toHaveCount(3);
  const dateInputs3 = page.locator('input[type="date"][data-field="date"]');
  await expect(dateInputs3).toHaveCount(3);
  await dateInputs3.nth(2).fill('2026-08-03');
  await page.waitForTimeout(600);

  const thirdToInput = legItems.nth(2).locator('.ch-tl-title[data-field="dropoffLocation"]');
  await pickPlace(page, thirdToInput, 'Galle', 'Galle');

  // Wait for a priced summary (chauffeur product, since driver/car stay is set)
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 10000 });
  const summaryTotal = await totalLineText(page);

  // Switch to the WhatsApp tab and inspect the <pre> output
  await page.locator('[data-action="setTab"][data-tab="whatsapp"]').click();
  const pre = page.locator('.ch-output-body .ch-pre');
  await expect(pre).toBeVisible({ timeout: 8000 });
  const waText = await pre.textContent();

  // A "Stay in" line exists and does NOT carry a trailing price on that same line
  const stayLine = waText.split('\n').find((l) => l.includes('Stay in'));
  expect(stayLine, waText).toBeTruthy();
  expect(stayLine).not.toMatch(/LKR|\$/);

  // Deposit line present
  expect(waText).toMatch(/Deposit to confirm/);

  // The WhatsApp total matches the Summary card's strong total line
  expect(waText).toContain(summaryTotal.trim());
});

// Spec 4 (S1): Stopovers are priced — adding a stopover chip increases distance
// (and therefore the total); removing it brings the total back down.
test('adding then removing a stopover changes the priced total (S1)', async ({ page }) => {
  await page.goto(TOOL);
  await page.waitForLoadState('networkidle');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Colombo City', 'Colombo');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Kand', 'Kandy');
  await fillFirstLegDate(page, '2026-08-01');

  // Wait for the initial (no-stopover) estimate
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });
  const baseline = await totalLineText(page);
  // Let the background auto-distance/estimate render() settle before typing — render()
  // replaces #app wholesale and can otherwise wipe the stop-input mid-keystroke.
  await page.waitForTimeout(600);

  // Add a stopover. NOTE: commit via blur (click elsewhere), not Enter — pressing Enter
  // double-submits the stopover here (the keydown handler adds it via updateLeg(), which
  // re-renders and replaces the input node, but the original node's blur teardown then
  // fires the *same* add-on-blur handler again with its still-populated value). That's a
  // real app bug (duplicate stopovers on Enter); tracked separately, not this file's to fix.
  const stopInput = page.locator('.ch-stop-input').first();
  await stopInput.click();
  await page.keyboard.type('Negombo', { delay: 30 });
  await expect(stopInput).toHaveValue('Negombo');
  await page.locator('#f-customerName').click();
  await expect(page.locator('.ch-stop-chip')).toHaveCount(1);

  // Wait for the total to change (distance re-resolves + re-estimates)
  await expect.poll(async () => totalLineText(page), { timeout: 10000 }).not.toBe(baseline);
  const withStopover = await totalLineText(page);

  // Remove the stopover
  await page.locator('.ch-stop-x').first().click();

  // Total should decrease back toward (or to) the baseline
  await expect.poll(async () => totalLineText(page), { timeout: 10000 }).not.toBe(withStopover);
  const afterRemoval = await totalLineText(page);

  const toNum = (s) => parseInt(String(s).replace(/[^\d]/g, ''), 10);
  expect(toNum(afterRemoval)).toBeLessThan(toNum(withStopover));
});

// Spec 5 (V5): Save→status sync — setting the status before the first save must
// be persisted (via the post-save PATCH) so the Recent list reflects it.
test('status chosen before first save is synced on save (V5)', async ({ page }) => {
  await page.goto(TOOL);
  await page.waitForLoadState('networkidle');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await fillFirstLegDate(page, '2026-08-01');
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });

  // Set status to Sent BEFORE saving
  await page.locator('#statusSelect').selectOption('sent');

  // Unique customer name so we can find the row unambiguously
  const custName = 'E2E Status ' + Date.now();
  await page.locator('#f-customerName').fill(custName);

  await page.locator('#btnSave').click();
  await expect(page.locator('.ch-toast-msg')).toContainText('Saved as', { timeout: 8000 });

  // Recent row for this customer should show status 'sent'
  const row = page.locator('.ch-recent-row', { hasText: custName });
  await expect(row).toBeVisible({ timeout: 8000 });
  await expect(row.locator('select[data-action="patchStatus"]')).toHaveValue('sent');
});

// Spec 6 (V19): Reopen — clicking a Recent row (not its status select) reopens
// the saved quote and repopulates the customer name.
test('clicking a Recent row reopens the saved quote (V19)', async ({ page }) => {
  await page.goto(TOOL);
  await page.waitForLoadState('networkidle');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await pickPlace(page, fromInput, 'Kand', 'Kandy');
  const toInput = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await pickPlace(page, toInput, 'Ella', 'Ella');
  await fillFirstLegDate(page, '2026-08-01');
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('LKR', { timeout: 8000 });

  const custName = 'E2E Reopen ' + Date.now();
  await page.locator('#f-customerName').fill(custName);
  await page.locator('#btnSave').click();
  await expect(page.locator('.ch-toast-msg')).toContainText('Saved as', { timeout: 8000 });

  // Start a fresh quote so we can prove the reopen repopulates the name
  page.once('dialog', (d) => d.accept());
  await page.locator('#btnNew').click();
  await expect(page.locator('#f-customerName')).toHaveValue('');

  // Click the Recent row itself (not the status select) to reopen
  const row = page.locator('.ch-recent-row', { hasText: custName });
  await expect(row).toBeVisible({ timeout: 8000 });
  await row.locator('.ch-recent-ref').click();

  await expect(page.locator('.ch-toast-msg')).toContainText('Reopened', { timeout: 8000 });
  await expect(page.locator('#f-customerName')).toHaveValue(custName);
});
