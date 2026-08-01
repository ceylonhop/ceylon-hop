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

/* The card could only ever say "first → last": projectBooking collapsed a trip's stops[] to
   from/to, so a four-stop tour rendered exactly like a direct transfer and there was no end
   date to show (owner, 2026-07-31). The chain now reaches the page, the title leads with what
   the trip IS, every hop gets a row, and the stop count appears on every card. */

const TRIP_VIEW = {
  reference: 'CH-TRIP1', status: 'payment_pending', mode: 'trip', firstName: 'Roshen',
  from: 'Colombo Airport (CMB)', to: 'Batticaloa',
  stops: ['Colombo Airport (CMB)', 'Sigiriya', 'Kandy', 'Batticaloa'],
  legDates: [futureIsoDate(30), futureIsoDate(32), futureIsoDate(34)],
  date: futureIsoDate(30), endDate: futureIsoDate(34), time: 'to confirm',
  travellers: 2, bags: null, vehicleType: 'car',
  currency: 'USD', totalCents: 22900, amountDueNowCents: 22900, balanceDueCents: 0,
};

const serve = (page, view) => page.route('**/bookings/view*', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }));

test('a multi-stop trip names every hop instead of hiding the middle', async ({ page }) => {
  await serve(page, TRIP_VIEW);
  await page.goto('/manage.html?t=fake-token');

  // The title leads with the shape of the trip, not a two-place route that reads as direct.
  await expect(page.locator('.pp-title')).toContainText(/Three journeys/i);
  // Every stop in the middle is now visible — this is what the customer could not see before.
  const rail = page.locator('.hops .hop');
  await expect(rail).toHaveCount(3);
  await expect(rail.nth(0)).toContainText('Sigiriya');
  await expect(rail.nth(1)).toContainText('Kandy');
  await expect(rail.nth(2)).toContainText('Batticaloa');
  // The rail styles moved to the shared ticket.css — assert they actually applied.
  await expect(page.locator('.hops .hop-dot').first()).toBeVisible();
});

test('trip start and end dates replace the bare pick-up row', async ({ page }) => {
  await serve(page, TRIP_VIEW);
  await page.goto('/manage.html?t=fake-token');
  const card = page.locator('.t-main');
  await expect(card).toContainText('Trip start');
  await expect(card).toContainText('Trip end');
  // The pick-up TIME is still its own row — it was never a place, and must not be lost.
  await expect(card).toContainText('Pick-up time');
  // Start and end must be DIFFERENT dates on a multi-day trip (the end date is the new fact).
  const start = await card.locator('.fact', { hasText: 'Trip start' }).innerText();
  const end = await card.locator('.fact', { hasText: 'Trip end' }).innerText();
  expect(start).not.toBe(end);
});

test('the stop count appears on every card, direct transfers included', async ({ page }) => {
  await serve(page, TRIP_VIEW);
  await page.goto('/manage.html?t=fake-token');
  await expect(page.locator('.fact', { hasText: 'Stops' })).toContainText('4 stops');

  // …and on a plain A→B, where it reads "2 stops · direct" rather than being omitted.
  const single = { ...VIEW, status: 'payment_pending', amountDueNowCents: 6000,
    stops: [VIEW.from, VIEW.to], legDates: [VIEW.date], endDate: VIEW.date };
  await serve(page, single);
  await page.goto('/manage.html?t=fake-token');
  const stops = page.locator('.fact', { hasText: 'Stops' });
  await expect(stops).toContainText('2 stops');
  await expect(stops).toContainText('direct');
  // A one-leg journey draws no rail, and its title stays the familiar route.
  await expect(page.locator('.hops')).toHaveCount(0);
  await expect(page.locator('.pp-title')).toContainText('Kandy');
  // Same-day trip: the end row says so instead of silently repeating the start date.
  await expect(page.locator('.fact', { hasText: 'Trip end' })).toContainText('same day');
});
