import { test, expect } from '@playwright/test';

// Owner report 2026-07-26: "when creating a new quote it [doesn't] show me the assign-to-person
// dropdown sometimes." Two independent causes, both fixed here:
//
//   1. renderHeaderAssign() returned '' whenever there was no savedId, so a brand-new quote had
//      no assign control AT ALL — it appeared only after the first save. That is the "sometimes".
//   2. init() awaited loadOpsUsers() and then only repainted INSIDE `if (rc)` — so whenever the
//      rate-card fetch failed (it returns null on any non-ok/throw) the roster landed with no
//      render, and the picker kept the empty option list it first painted with.
//
// Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const ME = 'op@e2e.test';

async function stubOps(page, opts = {}) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' },
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: ME, role: 'ops', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [
    { email: ME, displayName: 'Op E' }, { email: 'other@e2e.test', displayName: 'Other O' },
  ] })));
  // The rate card is the failure this spec cares about: null is what apiRateCard() returns
  // whenever the call is not ok, and that used to swallow the roster repaint.
  await page.route('**/admin/quote/rate-card', (r) => (opts.rateCardFails
    ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    : r.fulfill(json({ vehicle: { car: { maxPax: 3, maxBags: 3 } }, perKmCents: { car: 50 }, floorCents: { car: 0 } }))));
  await page.route('**/admin/quote/save', (r) => r.fulfill(json({ id: 'q1', reference: 'Q-ASN01', status: 'draft', assignedTo: ME })));
  // Spec 2026-07-29: "+ New quote" claims a real row up front, auto-assigned to its creator.
  // `draftFails` is the fallback path — the builder must degrade to the old manual-save behaviour.
  await page.route('**/admin/quote/draft', (r) => (opts.draftFails
    ? r.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    : r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'q1', reference: 'Q-SHL01', status: 'draft', assignedTo: ME }) })));
}

const picker = (page) => page.locator('.ch-header-tools #assignSel');

// Spec 2026-07-29: "+ New quote" claims the row on the server before anything is priceable, so
// an agent on a live call can hand the ticket over without pressing Save first. The picker used
// to be DISABLED until the first save; it is now live from the first frame.
test('a brand-new quote shows the assign control, live and on its creator', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE);
  await page.locator('#view [data-qnew]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Present from the very first paint — not conjured by the first save.
  await expect(picker(page)).toBeVisible({ timeout: 10000 });
  // The row exists, so the picker is usable: no Save click stands between the operator and
  // handing the ticket to a colleague.
  await expect(picker(page)).toBeEnabled({ timeout: 10000 });
  await expect(picker(page)).toHaveAttribute('title', /reassign/i);
  // The server auto-assigns a new row to its creator, so it opens on the maker.
  await expect(picker(page)).toHaveValue(ME, { timeout: 10000 });
});

// The one state that still disables it: the draft create failed, so there is genuinely no row.
// This is also where the placeholder-selected regression lives.
test('a failed draft create falls back to a disabled picker that still shows its placeholder', async ({ page }) => {
  await stubOps(page, { draftFails: true });
  await page.goto(OPS_FILE);
  await page.locator('#view [data-qnew]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  await expect(picker(page)).toBeVisible({ timeout: 10000 });
  await expect(picker(page)).toBeDisabled();
  await expect(picker(page)).toHaveAttribute('title', /save it to assign/i);

  // It must SHOW something. morphdom patches this <select>'s children in place when the roster
  // lands, and with no option carrying `selected` the browser leaves selectedIndex at -1 and
  // renders an empty box — which is what "the dropdown isn't there" actually looked like.
  const shown = await page.evaluate(() => {
    const s = document.getElementById('assignSel');
    return { idx: s.selectedIndex, text: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : null };
  });
  expect(shown.idx).toBe(0);
  expect(shown.text).toMatch(/unassigned/i);
});

test('a saved but unassigned quote still shows a populated picker after a repaint', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await page.locator('.ch-header [data-action="saveDraft"]').click();
  await expect(picker(page)).toBeEnabled({ timeout: 10000 });

  // Unassign, then force repaints. The select must keep displaying its placeholder.
  await picker(page).selectOption('');
  await page.locator('[data-action="setVehicle"][data-veh="van_6"]').click();
  await expect.poll(async () => page.evaluate(() => document.getElementById('assignSel').selectedIndex),
    { timeout: 10000 }).toBe(0);
  await expect(picker(page)).toContainText('Unassigned', { timeout: 10000 });
});

test('the roster is populated even when the rate-card fetch fails', async ({ page }) => {
  await stubOps(page, { rateCardFails: true });
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Unassigned + both roster members. Before the fix this was just "Unassigned".
  await expect(picker(page).locator('option')).toHaveCount(3, { timeout: 10000 });
  await expect(picker(page)).toContainText('Op E');
  await expect(picker(page)).toContainText('Other O');
});

test('saving enables the picker on the creator', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');

  await page.locator('.ch-header [data-action="saveDraft"]').click();
  await expect(picker(page)).toBeEnabled({ timeout: 10000 });
  await expect(picker(page)).toHaveValue(ME, { timeout: 10000 });
});
