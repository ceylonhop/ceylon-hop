import { test, expect } from '@playwright/test';

import { futureIsoDate } from '../dates.js';

/* Trip dates are anchored to "now", never hard-coded: a literal calendar date makes the
   suite go red on its own once the clock passes it (docs/known-bugs.md, 2026-07-25). */


const VIEW = {
  reference: 'CH-ABC12', status: 'paid', mode: 'single', firstName: 'Maya',
  from: 'Colombo Airport (CMB)', to: 'Kandy', date: futureIsoDate(30), time: '09:00',
  travellers: 2, bags: 1, vehicleType: 'car',
  currency: 'USD', totalCents: 6000, amountDueNowCents: 6000, balanceDueCents: 0,
};

test('renders the booking view for a valid token', async ({ page }) => {
  await page.route('**/bookings/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VIEW) }));
  await page.goto('/manage.html?t=fake-token');
  await expect(page.locator('body')).toContainText('CH-ABC12');
  await expect(page.locator('body')).toContainText('Kandy');
});

test('shows a friendly error for an invalid link', async ({ page }) => {
  await page.route('**/bookings/view*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid_link"}' }));
  await page.goto('/manage.html?t=bad');
  await expect(page.locator('body')).toContainText(/isn.t valid|couldn.t find|WhatsApp/i);
  // never a blank page
  await expect(page.locator('body')).not.toHaveText('');
});
