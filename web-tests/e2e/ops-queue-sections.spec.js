import { test, expect } from '@playwright/test';

// Owner report 2026-07-26: "'Assigned to me' and 'Ready to send' are confusing — sometimes
// assigned-to-me quotes ARE ready to send." The queue used to PARTITION: a quote assigned to
// you was lifted OUT of its status section into an "Assigned to me" section, so an approved
// quote of yours never appeared under "Ready to send" at all. Status is now the only axis;
// "mine" is an attribute of the row (the `you` chip) and sorts to the top of its section.
// Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const ME = 'founder@e2e.test';

const q = (id, name, status, assignedTo) => ({
  id, reference: 'Q-' + id.toUpperCase(), customerName: name,
  product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD',
  status, assignedTo, createdAt: '2026-07-26T09:00:00.000Z',
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

test('an approved quote assigned to me appears under Ready to send, not a separate section', async ({ page }) => {
  await stubQueue(page, [
    q('mine1', 'Mine Ready', 'ready', ME),
    q('their1', 'Their Ready', 'ready', 'ops@e2e.test'),
  ]);
  await page.goto(OPS_FILE + '#quotes');
  await expect(page.locator('.qrow[data-qopen="mine1"]')).toBeVisible({ timeout: 10000 });

  // The section is gone entirely.
  await expect(page.locator('.qsection-title', { hasText: 'Assigned to me' })).toHaveCount(0);
  await expect(page.locator('.qsec-mine')).toHaveCount(0);

  // Both approved quotes sit in the one "Ready to send" section, mine included.
  const ready = page.locator('.qsec-ready');
  await expect(ready.locator('.qsection-title')).toContainText('Ready to send');
  await expect(ready.locator('.qsection-count')).toHaveText('2');
  await expect(ready.locator('.qrow[data-qopen="mine1"]')).toHaveCount(1);
  await expect(ready.locator('.qrow[data-qopen="their1"]')).toHaveCount(1);

  // No quote is ever rendered twice.
  await expect(page.locator('.qrow[data-qopen="mine1"]')).toHaveCount(1);
});

test('my rows carry the you chip and sort to the top of their section', async ({ page }) => {
  await stubQueue(page, [
    q('their1', 'Their Ready', 'ready', 'ops@e2e.test'),
    q('nobody1', 'Nobody Ready', 'ready', null),
    q('mine1', 'Mine Ready', 'ready', ME),
  ]);
  await page.goto(OPS_FILE + '#quotes');
  await expect(page.locator('.qrow[data-qopen="mine1"]')).toBeVisible({ timeout: 10000 });

  const rows = page.locator('.qsec-ready .qrow');
  await expect(rows).toHaveCount(3);
  // Mine is first despite arriving last from the server.
  await expect(rows.nth(0)).toHaveAttribute('data-qopen', 'mine1');
  // The chip is what marks it as mine — it must be present on my row now that the section is gone.
  await expect(rows.nth(0).locator('.qassignee.mine')).toHaveText('you');
  // The other rows keep naming their holder (or say nobody does).
  await expect(rows.nth(1).locator('.qassignee')).not.toHaveClass(/mine/);
  await expect(page.locator('.qrow[data-qopen="nobody1"] .qassignee.nobody')).toHaveText('Unassigned');
});
