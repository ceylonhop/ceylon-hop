import { test, expect } from '@playwright/test';

// Quotes LIST flicker (owner video, 2026-07-22): opening the Quotes page reloaded the list a
// few times. viewQuotes() paints 2–3 times per entry as async data lands — the initial
// "Loading" paint, then /admin/quote/list, then the staff names from /admin/ops/users — and
// each paint used to be a full `#view` innerHTML swap that wiped and rebuilt the whole list.
// viewQuotes() now diff-renders with morphdom (like the builder's render()), so a late data
// arrival patches only the changed cells and leaves every unchanged row node alone.
//
// This pins that contract the same way ops-render-stability.spec.js does for the builder: tag
// a live row node with a JS property (it survives only if the NODE survives — an innerHTML
// rebuild loses it), let the delayed staff-name fetch land and re-render, then assert the row
// node is the SAME node AND its assignee cell actually updated (so survival isn't just "no
// second render"). Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

test('late staff-name data patches the quotes list in place — no wholesale reload', async ({ page }) => {
  // Google Identity stub so boot's initGoogleButton() doesn't hang on the GIS script.
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } };
  });

  // Catch-all FIRST so the specific routes below (registered later) take precedence —
  // Playwright resolves a request with the most-recently-registered matching handler.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  // Signed-in founder: quote:manage unlocks the Quotes route, quote:approve → approver sections.
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve'] })));
  // One quote, assigned to someone ELSE so its assignee chip is shown (and its label will
  // change once the roster lands). pending_review → "Needs your review" for an approver.
  await page.route('**/admin/quote/list', (r) =>
    r.fulfill(json({ quotes: [{
      id: 'Q-TEST1', reference: 'Q-TEST1', customerName: 'Alice Traveler',
      product: 'Private', vehicle: 'Car', totalCents: 22900, status: 'pending_review',
      assignedTo: 'agent@e2e.test', createdAt: new Date().toISOString(),
    }] })));
  // The staff roster is HELD until the test releases it — this makes ordering deterministic
  // (a fixed timeout races loadOpsQuotes and flakes): the list is guaranteed to paint first
  // with the email-local-part fallback ('agent'), and only re-renders to the display name after
  // we've tagged the row. loadOpsRoster() is fire-and-forget at boot, so holding it just delays
  // the names re-render — nothing else blocks.
  let releaseRoster;
  const rosterHeld = new Promise((res) => { releaseRoster = res; });
  await page.route('**/admin/ops/users', async (r) => {
    await rosterHeld;
    await r.fulfill(json({ users: [{ email: 'agent@e2e.test', displayName: 'Agent Ada' }] }));
  });

  await page.goto(OPS_FILE + '#quotes');

  // First list paint (roster still held): the row is present and its assignee reads 'agent'.
  const chip = page.locator('.qrow[data-qopen="Q-TEST1"] .qassignee');
  await expect(chip).toHaveText('agent', { timeout: 10000 });

  // Tag the live row node. A JS property lives on the node object, so it survives iff the node
  // survives a re-render.
  await page.evaluate(() => {
    document.querySelector('.qrow[data-qopen="Q-TEST1"]').__stableTag = true;
  });

  // Release the roster → loadOpsRoster() lands → viewQuotes() re-renders. The label must update
  // (proves a real second paint)…
  releaseRoster();
  await expect(chip).toHaveText('Agent Ada', { timeout: 10000 });

  // …while the row NODE stayed the SAME one. Under the old innerHTML swap the tagged node would
  // have been discarded and rebuilt (undefined tag); morphdom patches it in place.
  const survived = await page.evaluate(() =>
    !!(document.querySelector('.qrow[data-qopen="Q-TEST1"]') || {}).__stableTag);
  expect(survived).toBe(true);
});
