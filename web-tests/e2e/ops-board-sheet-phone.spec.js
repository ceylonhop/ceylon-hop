import { test, expect } from '@playwright/test';

// Owner 2026-09-23: opening a Ride Board van in ops shows each traveller's phone number (the
// one they gave on the join form), tapping through to WhatsApp — the same way a normal
// booking's sheet already shows the customer's number. Members who joined before numbers were
// stored have none on file and say so.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const VAN = {
  id: 'board:CS-9117', reference: 'CS-9117', mode: 'board', channel: 'website',
  bookingStatus: 'gathering', stage: 'gathering', paymentStatus: 'unpaid', amount: 6500, currency: 'USD',
  customerFirstName: 'Cherlyn', customerName: 'Cherlyn + 1', customerPhone: null,
  route: 'Colombo city → Sigiriya / Dambulla', travelDate: '2030-12-24', travelTime: '08:00', pax: 2,
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: null, source: 'ride_board',
  board: {
    code: 'CS-9117', listStatus: 'gathering', seatsCommitted: 2, minSeats: 3, capacity: 6, seatPrice: 3250,
    cutoffAt: '2030-12-23T01:30:00.000Z',
    members: [
      { position: 1, firstName: 'Cherlyn', country: 'SG', phone: '+65 9123 4567', seats: 1, status: 'held' },
      { position: 2, firstName: 'Tom', country: 'DE', phone: null, seats: 1, status: 'held' },
    ],
  },
};

test('the Ride Board sheet lists each traveller with their number, linked to WhatsApp', async ({ page }) => {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps: ['bookings:read'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([VAN])));
  await page.goto(OPS_FILE);
  await page.locator('.tk[data-id="board:CS-9117"]').click();
  const sheet = page.locator('#sheet');
  await expect(sheet).toContainText('Cherlyn');
  const link = sheet.locator('.mrow a.mph');
  await expect(link).toHaveText('+65 9123 4567');
  await expect(link).toHaveAttribute('href', 'https://wa.me/6591234567');
  await expect(sheet.locator('.mrow').nth(1)).toContainText('No number on file');
});
