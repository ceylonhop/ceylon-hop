import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo, type NewBooking } from './bookingRepo';

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const seat = (date: string, time: string, seats: number): NewBooking => ({
  mode: 'shared', input: { corridorId: 'airport-cultural', date, time, seats, customer },
  total: 2749 * seats, amountDueNow: 2749 * seats, currency: 'USD',
});

describe('InMemoryBookingRepo.paidSharedSeats', () => {
  it('sums paid seats per departure inside the window — nothing unpaid, cancelled or outside it', async () => {
    const repo = new InMemoryBookingRepo();
    const pay = async (b: NewBooking) => {
      const x = await repo.create(b);
      await repo.setStatus(x.id, 'payment_pending');
      return repo.setStatus(x.id, 'paid');
    };
    await pay(seat('2099-08-12', '07:00', 2));
    await pay(seat('2099-08-12', '07:00', 1));
    const gone = await pay(seat('2099-08-12', '07:00', 5));
    await repo.setStatus(gone.id, 'cancelled');
    await repo.create(seat('2099-08-12', '07:00', 4));        // checkout started, never paid
    const pending = await repo.create(seat('2099-08-12', '07:00', 6));
    await repo.setStatus(pending.id, 'payment_pending');      // at the payment page, never paid
    await pay(seat('2099-09-30', '07:00', 3));                // outside the window
    expect(await repo.paidSharedSeats('2099-08-11', '2099-08-25')).toEqual([
      { corridorId: 'airport-cultural', date: '2099-08-12', time: '07:00', seats: 3 },
    ]);
  });
});
