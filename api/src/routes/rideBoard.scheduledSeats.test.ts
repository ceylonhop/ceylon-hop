import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';

// GET /board/scheduled-seats (plan 2026-10-19-ride-board-fomo, PR 3): paid seats per scheduled
// taxi, as a count — never who.
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const seat = (time: string, seats: number, date = '2099-08-12'): NewBooking => ({
  mode: 'shared', input: { corridorId: 'airport-cultural', date, time, seats, customer },
  total: 2749 * seats, amountDueNow: 2749 * seats, currency: 'USD',
});
async function paid(repo: InMemoryBookingRepo, b: NewBooking) {
  const x = await repo.create(b);
  await repo.setStatus(x.id, 'payment_pending');
  return repo.setStatus(x.id, 'paid');
}

describe('GET /board/scheduled-seats', () => {
  it('counts paid seats per van, on every boarding time that rides it — and names nobody', async () => {
    const bookings = new InMemoryBookingRepo();
    await paid(bookings, seat('07:00', 3));
    await paid(bookings, seat('07:30', 2));
    await bookings.create(seat('07:00', 4)); // checkout started, never paid
    const app = createApp({ bookings });
    const res = await app.request('/board/scheduled-seats?from=2099-08-11&days=14');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await res.json();
    expect(body.departures).toHaveLength(2);
    expect(body.departures).toEqual(expect.arrayContaining([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', booked: 5 },
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:30', booked: 5 },
    ]));
    expect(JSON.stringify(body)).not.toContain('Maya');
  });
  it('leaves out seats outside the window', async () => {
    const bookings = new InMemoryBookingRepo();
    await paid(bookings, seat('07:00', 3, '2099-09-30'));
    const body = await (await createApp({ bookings }).request('/board/scheduled-seats?from=2099-08-11&days=14')).json();
    expect(body.departures).toEqual([]);
  });
  it('refuses a date it cannot read', async () => {
    const app = createApp({ bookings: new InMemoryBookingRepo() });
    expect((await app.request('/board/scheduled-seats?from=next-week')).status).toBe(400);
    expect((await app.request('/board/scheduled-seats?from=2099-02-31')).status).toBe(400);
    expect((await app.request('/board/scheduled-seats?from=2000-01-01')).status).toBe(400); // history is not public
  });
});
