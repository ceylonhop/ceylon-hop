import { test, expect } from '@playwright/test';

// Spec 2026-08-01: 20 of the 45 sent quotes in the live queue are for trips that already
// departed — `lost`/`expired` have never once been used, so `sent` is terminal in practice and
// the working list fills with dead deals. Those rows now drop out of "Sent & closed" into their
// own "Trip date passed" group at the bottom. Derived only: no status is written.
// Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const ME = 'founder@e2e.test';

// Anchored to the wall clock so the fixture can never rot: the UI judges against Colombo's
// today, so "60 days ago" has to move with it.
const shift = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const q = (id, name, status, extra = {}) => ({
  id, reference: 'Q-' + id.toUpperCase(), customerName: name,
  product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD',
  status, assignedTo: ME, createdAt: new Date(Date.now() - 6 * 86400000).toISOString(),
  travelDate: null, sentAt: null, ...extra,
});

async function stubQueue(page, quotes) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [{ email: ME, displayName: 'Devan S.' }] })));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: ME, role: 'founder', caps: ['quote:manage', 'quote:approve'] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes })));
}

test('a sent quote whose trip has passed leaves Sent & closed for its own section', async ({ page }) => {
  await stubQueue(page, [
    q('past1', 'Trip Over', 'sent', { travelDate: shift(-10), sentAt: new Date(Date.now() - 20 * 86400000).toISOString() }),
    q('live1', 'Still Coming', 'sent', { travelDate: shift(30), sentAt: new Date(Date.now() - 2 * 86400000).toISOString() }),
    q('won1', 'Booked', 'won', { travelDate: shift(-10) }),
  ]);
  await page.goto(OPS_FILE + '#quotes');
  await expect(page.locator('.qrow[data-qopen="live1"]')).toBeVisible({ timeout: 10000 });

  const over = page.locator('.qsec-tripover');
  await expect(over.locator('.qsection-title')).toContainText('Trip date passed');
  await expect(over.locator('.qsection-count')).toHaveText('1');
  await expect(over.locator('.qrow[data-qopen="past1"]')).toHaveCount(1);

  // The live quote and the won one stay put; only the dead sent quote moves.
  const closed = page.locator('.qsec-closed');
  await expect(closed.locator('.qrow[data-qopen="live1"]')).toHaveCount(1);
  await expect(closed.locator('.qrow[data-qopen="won1"]')).toHaveCount(1);
  await expect(closed.locator('.qrow[data-qopen="past1"]')).toHaveCount(0);

  // No quote is ever rendered twice.
  for (const id of ['past1', 'live1', 'won1']) {
    await expect(page.locator(`.qrow[data-qopen="${id}"]`)).toHaveCount(1);
  }
});

test('the trip-date section sinks below every working section', async ({ page }) => {
  await stubQueue(page, [
    q('past1', 'Trip Over', 'sent', { travelDate: shift(-10) }),
    q('ready1', 'Ready One', 'ready'),
  ]);
  await page.goto(OPS_FILE + '#quotes');
  await expect(page.locator('.qrow[data-qopen="ready1"]')).toBeVisible({ timeout: 10000 });

  const sections = page.locator('.qsection');
  await expect(sections.last()).toHaveClass(/qsec-tripover/);
});

test('an undated sent quote is left to the server-side sweep, however old', async ({ page }) => {
  // Send-age policy has one owner: expireStaleQuotes (180 days, PR #214). The queue must not
  // run a second, shorter clock of its own over the same quotes.
  await stubQueue(page, [
    q('old1', 'Old Undated', 'sent', { sentAt: new Date(Date.now() - 365 * 86400000).toISOString() }),
  ]);
  await page.goto(OPS_FILE + '#quotes');
  await expect(page.locator('.qrow[data-qopen="old1"]')).toBeVisible({ timeout: 10000 });

  await expect(page.locator('.qsec-tripover')).toHaveCount(0);
  await expect(page.locator('.qsec-closed .qrow[data-qopen="old1"]')).toHaveCount(1);
});

test('quotes the rule cannot judge stay in the working list', async ({ page }) => {
  await stubQueue(page, [
    q('nodate1', 'No Dates', 'sent'),
    q('junk1', 'Junk Date', 'sent', { travelDate: 'next Tuesday' }),
  ]);
  await page.goto(OPS_FILE + '#quotes');
  await expect(page.locator('.qrow[data-qopen="nodate1"]')).toBeVisible({ timeout: 10000 });

  await expect(page.locator('.qsec-tripover')).toHaveCount(0);
  await expect(page.locator('.qsec-closed .qrow')).toHaveCount(2);
});
