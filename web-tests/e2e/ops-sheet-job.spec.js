import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Spec 2026-11-12 (booking pane, PR 1): the header answers "what do I tell the coordinator?"
// before any scrolling: the vehicle the customer PAID for, the party, the bags. A van booking
// was once sent a car because the header showed only "3 guests".

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const CUSTOMER = { whatsapp: '+94 77 000 0000', email: 'c@example.com', country: 'Spain' };

const row = (id, ref, mode, extra = {}) => ({
  id, reference: ref, channel: 'website', customerName: 'Alpha Customer', customerFirstName: 'Alpha',
  mode, route: 'A → B', travelDate: futureIsoDate(30), travelTime: '09:00', pax: 3,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null, ...extra,
});
const detail = (id, ref, mode, input, vehicle, extra = {}) => ({
  payLink: null, vehicle,
  booking: { id, reference: ref, currency: 'USD', status: 'paid', mode, createdAt: '2026-09-01T00:00:00Z', input: { customer: CUSTOMER, ...input }, ...extra },
  ops: { updatedAt: '2026-09-02T00:00:00Z' },
  payments: [{ id: 'p1', status: 'succeeded', amount: 3900, currency: 'USD' }],
  refunds: [],
});

const D = (n) => futureIsoDate(n);
const BOOKINGS = {
  van: [row('van', 'CH-0001', 'single'), detail('van', 'CH-0001', 'single',
    { from: 'Colombo Airport (CMB), Katunayake', to: 'Kandy, Earl’s Regency', date: D(30), time: '06:30', vehicleType: 'van', adults: 2, children: 1, bags: 4, routeVariant: 'no_tolls' }, 'van')],
  trip: [row('trip', 'CH-0002', 'trip', { serviceType: 'private' }), detail('trip', 'CH-0002', 'trip',
    { stops: ['Negombo, Grand Royal villa', 'Ella, Senasuma Inn', 'Panama, Vista Villa'], dates: [D(30), D(32)], pax: 2, vehicleType: 'car', serviceType: 'private' }, 'car')],
  mid: [row('mid', 'CH-0003', 'trip', { serviceType: 'private', travelDate: D(-5), legs: [{ date: D(-5), from: 'Negombo', to: 'Ella' }, { date: D(-3), from: 'Ella', to: 'Panama' }, { date: D(3), from: 'Panama', to: 'Udawalawe' }] }), detail('mid', 'CH-0003', 'trip',
    { stops: ['Negombo, A', 'Ella, B', 'Panama, C', 'Udawalawe, D'], dates: [D(-5), D(-3), D(3)], pax: 2, vehicleType: 'car', serviceType: 'private' }, 'car')],
  chauffeur: [row('chauffeur', 'CH-0004', 'trip', { serviceType: 'chauffeur' }), detail('chauffeur', 'CH-0004', 'trip',
    { stops: ['Colombo, X', 'Kandy, Y'], dates: [D(30)], pax: 2, vehicleType: 'car', serviceType: 'chauffeur', days: 6, driverNights: 5 }, 'car')],
  shared: [row('shared', 'CH-0005', 'shared'), detail('shared', 'CH-0005', 'shared',
    { corridorId: 'c1', fromPlace: 'Ella', toPlace: 'Mirissa', date: D(30), time: '07:30', seats: 2, bags: 2 }, null)],
  novehicle: [row('novehicle', 'CH-0006', 'single'), detail('novehicle', 'CH-0006', 'single',
    { from: 'A, x', to: 'B, y', date: D(30), time: '09:00', vehicleType: 'car', adults: 1, children: 0 }, null)],
};

async function boot(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Catch-all first: Playwright gives precedence to the LAST matching route.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(Object.values(BOOKINGS).map(([rw]) => rw))));
  for (const [id, [, d]] of Object.entries(BOOKINGS)) {
    await page.route(`**/admin/ops/bookings/${id}`, (r) => r.fulfill(json(d)));
  }
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

async function open(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}
const stub = (page) => page.locator('#sheet .sheet-stub');

test('the header names the vehicle paid for, beside the party and the bags', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(stub(page).getByTestId('sheet-vehicle')).toHaveText('Van 6 Seat');
  await expect(stub(page).locator('.stub-veh .ss').first()).toHaveText('paid for');
  await expect(stub(page).getByTestId('sheet-guests')).toHaveText('3');
  await expect(stub(page).locator('.stub', { has: page.getByTestId('sheet-guests') }).locator('.ss')).toHaveText('2 adults · 1 child');
  await expect(stub(page).getByTestId('sheet-bags')).toHaveText('4');
  await expect(stub(page).getByTestId('sheet-when')).toContainText(/\d/);
  // The total left the header: money isn't what ops tell the coordinator.
  await expect(stub(page)).not.toContainText('Total');
  // One vehicle on the pane, in the header: the old Trip-block row is gone.
  await expect(page.locator('#sheet [data-testid="sheet-vehicle"]')).toHaveCount(1);
});

test('a trip says bags were never asked', async ({ page }) => {
  await boot(page);
  await open(page, 'trip');
  await expect(stub(page).getByTestId('sheet-vehicle')).toHaveText('Car');
  await expect(stub(page).getByTestId('sheet-bags')).toHaveText('—');
  await expect(stub(page).locator('.stub', { has: page.getByTestId('sheet-bags') }).locator('.ss')).toHaveText('not asked');
});

test('a trip under way shows its next leg in the header', async ({ page }) => {
  await boot(page);
  await open(page, 'mid');
  const when = stub(page).locator('.stub', { has: page.getByTestId('sheet-when') });
  await expect(when.locator('.sl')).toHaveText('Next leg');
  await expect(when.locator('.ss')).toContainText('leg 3 of 3 · started');
});

test('a chauffeur guide shows the driver and the days', async ({ page }) => {
  await boot(page);
  await open(page, 'chauffeur');
  await expect(stub(page).locator('.stub-veh .sv')).toHaveText('Car + driver');
  await expect(stub(page).locator('.stub-veh .ss').first()).toHaveText('paid for · 6 days');
});

test('a shared seat shows seats, not a vehicle', async ({ page }) => {
  await boot(page);
  await open(page, 'shared');
  await expect(stub(page).getByTestId('sheet-seats')).toHaveText('2 shared seats');
  await expect(stub(page).getByTestId('sheet-vehicle')).toHaveCount(0);
  await expect(stub(page).locator('.stub', { has: page.getByTestId('sheet-when') }).locator('.sl')).toHaveText('Departs');
});

test('a booking with no vehicle on record says so, never blank', async ({ page }) => {
  await boot(page);
  await open(page, 'novehicle');
  await expect(stub(page).getByTestId('sheet-vehicle-missing')).toHaveText('Not on record');
});

test('on a phone the vehicle cell carries the party and bags', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await open(page, 'van');
  await expect(stub(page).locator('.stub-veh .ss-narrow')).toBeVisible();
  await expect(stub(page).locator('.stub-veh .ss-narrow')).toHaveText('3 guests · 4 bags');
  await expect(stub(page).getByTestId('sheet-guests')).toBeHidden();
});

test('a toll-free leg says "No expressway"', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(page.locator('#sheet .legs [data-testid="leg-road"]')).toHaveText(['No expressway']);
});

test('every other leg says "Expressway OK"', async ({ page }) => {
  await boot(page);
  await open(page, 'trip');
  await expect(page.locator('#sheet .legs [data-testid="leg-road"]')).toHaveText(['Expressway OK', 'Expressway OK']);
});

test('every leg still to run shows its full addresses; a leg that ran shrinks to one line', async ({ page }) => {
  await boot(page);
  await open(page, 'mid');
  const legs = page.locator('#sheet .legs .leg');
  await expect(legs).toHaveCount(3);
  await expect(legs.nth(0)).toHaveClass(/leg-done/);
  await expect(legs.nth(0).locator('.addr')).toHaveCount(0);
  await expect(legs.nth(2)).toHaveClass(/leg-next/);
  await expect(legs.nth(2).locator('.addr')).toContainText('Panama, C');
  await expect(legs.nth(2).locator('.addr')).toContainText('Udawalawe, D');
  await expect(legs.nth(2).locator('.lt')).toContainText('Panama → Udawalawe');
});

test('a single transfer gets a leg row with its time, not "no leg breakdown"', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(page.locator('#sheet .legs .leg .lt')).toContainText('Colombo Airport (CMB) → Kandy');
  await expect(page.locator('#sheet .legs .leg .lt')).toContainText('06:30');
  await expect(page.locator('#sheet .sheet-b')).not.toContainText('no leg breakdown');
});

test('a shared seat gets its catalogue leg and no road label', async ({ page }) => {
  await boot(page);
  await open(page, 'shared');
  await expect(page.locator('#sheet .legs .leg .lt')).toContainText('Ella → Mirissa');
  await expect(page.locator('#sheet .legs [data-testid="leg-road"]')).toHaveCount(0);
});

test('the route is said once: no separate Route or Road row', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(page.locator('#sheet .sheet-b .kv .k', { hasText: /^(Route|Road)$/ })).toHaveCount(0);
});
