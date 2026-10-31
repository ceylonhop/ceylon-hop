import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Customers could not tell where the shared taxi picks them up or sets them down: the manage card
// named the towns only (owner, 2026-10-29). The view now carries the leg's published points and
// the card names both, each linking to Google Maps. Offline: /bookings/view is stubbed.
const DAY = futureIsoDate(30);
const VIEW = {
  reference: 'CH-SEAT1', status: 'paid', mode: 'shared', firstName: 'Maya',
  from: 'Sigiriya / Dambulla', to: 'Kandy', date: DAY, endDate: DAY, time: '11:30',
  stops: ['Sigiriya / Dambulla', 'Kandy'], legDates: [DAY],
  travellers: 1, vehicleType: null, totalCents: 1999, balanceDueCents: 0, amountDueNowCents: 0, paidCents: 1999, currency: 'USD',
  pickupPoint: 'Barista Cafe, Sigiriya', dropoffPoint: 'Kandy City Centre',
};

async function stub(page, view) {
  await page.route((u) => u.pathname.endsWith('/bookings/view'), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }));
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
}

test('a shared booking names its pick-up and drop-off points, each linking to Maps', async ({ page }) => {
  await stub(page, VIEW);
  await page.goto('/manage.html?t=test-token');
  await expect(page.locator('.fact', { hasText: 'Pick-up point' })).toContainText('Barista Cafe, Sigiriya');
  await expect(page.locator('.fact', { hasText: 'Drop-off point' })).toContainText('Kandy City Centre');
  const maps = await page.locator('.fact a.pt-map').evaluateAll((as) => as.map((a) => a.href));
  expect(maps).toEqual([
    'https://www.google.com/maps/search/?api=1&query=Barista%20Cafe%2C%20Sigiriya%2C%20Sri%20Lanka',
    'https://www.google.com/maps/search/?api=1&query=Kandy%20City%20Centre%2C%20Sri%20Lanka',
  ]);
});

test('a booking without points shows no point rows', async ({ page }) => {
  const { pickupPoint, dropoffPoint, ...bare } = VIEW;
  await stub(page, bare);
  await page.goto('/manage.html?t=test-token');
  await expect(page.locator('.fact', { hasText: 'Travellers' })).toBeVisible();
  await expect(page.locator('.fact', { hasText: 'Pick-up point' })).toHaveCount(0);
});
