import { test, expect } from '@playwright/test';

// Provenance footer (owner, 2026-07-22): the "Created by … · last updated by …" line moved from
// the top of the editor to a quiet footer at the bottom-right of the builder, and it now names
// the person (userLabel maps the email → display name, e.g. "Roshen W.") with the full email kept
// on hover. This pins both: the label is the NAME not the email, and the line sits AFTER the
// cockpit (editor + money pane) as a right-aligned footer. Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const CREATOR = 'roshenw@gmail.com';
const NAME = 'Roshen W.';

// A ready (rate-locked) quote the builder can reopen without a live estimate, carrying the
// created/updated-by emails the footer renders.
const FULL_QUOTE = {
  id: 'q1', reference: 'Q-Q1', channel: 'ops', status: 'ready',
  product: 'private', vehicle: 'car',
  customerName: 'Alice Traveler', customerContact: '+94 77 123 4567',
  totalCents: 12100, currency: 'USD', notes: null,
  createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T10:00:00.000Z',
  createdBy: CREATOR, updatedBy: CREATOR,
  request: { tool: {
    name: 'Alice Traveler', contact: '+94 77 123 4567', vehicle: 'car', service: 'private',
    requestedService: 'private', passengerCount: 2, luggageCount: 2,
    legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
  } },
  result: { totalCents: 12100 },
  estimate: {
    product: 'private', total: { cents: 12100, lkr: 'LKR 39,930' },
    lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 12100 }], warnings: [],
  },
};

test('created/updated-by is a bottom-right footer that names the person, email on hover', async ({ page }) => {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async () => ({}) } };
  });

  // Catch-all FIRST; specific routes after (Playwright: last-registered wins).
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json(FULL_QUOTE.estimate)));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [
    { id: 'q1', reference: 'Q-Q1', customerName: 'Alice Traveler', product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD', status: 'ready' },
  ] })));
  await page.route(/\/admin\/quote\/q1$/, (r) => r.fulfill(json(FULL_QUOTE)));
  // Roster so userLabel(CREATOR) resolves to the display name.
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [{ email: CREATOR, displayName: NAME }] })));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve'] })));

  // Deep-link straight into the saved quote in the builder.
  await page.goto(OPS_FILE + '?quote=q1#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  const prov = page.locator('.ch-provenance');
  await expect(prov).toBeVisible({ timeout: 10000 });

  // 1) Names the person, not the email.
  await expect(prov).toContainText('Created by ' + NAME);
  await expect(prov).toContainText('last updated by ' + NAME);
  await expect(prov).not.toContainText('@gmail.com'); // email is not in the visible text

  // 2) The full email is preserved on hover (title on the name span).
  await expect(prov.locator('span[title="' + CREATOR + '"]').first()).toHaveText(NAME);

  // 3) Bottom-right footer: it follows the money pane in DOM order, lives inside .ch-container,
  //    and is right-aligned.
  const layout = await page.evaluate(() => {
    const prov = document.querySelector('.ch-provenance');
    const money = document.querySelector('.ch-money');
    const cust = document.querySelector('.ch-cust-strip');
    return {
      inContainer: !!prov.closest('.ch-container'),
      afterMoney: !!(money && (money.compareDocumentPosition(prov) & Node.DOCUMENT_POSITION_FOLLOWING)),
      afterCustomerStrip: !!(cust && (cust.compareDocumentPosition(prov) & Node.DOCUMENT_POSITION_FOLLOWING)),
      textAlign: getComputedStyle(prov).textAlign,
    };
  });
  expect(layout).toEqual({ inContainer: true, afterMoney: true, afterCustomerStrip: true, textAlign: 'right' });
});
