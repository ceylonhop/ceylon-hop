import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { cancelSupersededBooking, SUPERSEDED_BY } from './supersededPayLink';
import { futureIsoDate } from '../testSupport/dates';

// A re-minted pay link retires the old one, so the booking the customer started on the old link can
// never be paid through it again. This is the guard that decides whether it may be closed.

const customer = { firstName: 'Nimal', lastName: 'Perera', email: 'nimal@x.com', whatsapp: '+94770001111', country: 'LK' };

async function setup(status: 'draft' | 'payment_pending' | 'paid' | 'confirmed') {
  const bookings = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
  const payments = new InMemoryPaymentRepo();
  const b = await bookings.create({
    mode: 'single',
    input: { from: 'Colombo Airport (CMB)', to: 'Galle', date: futureIsoDate(30), time: '09:00', vehicleType: 'car', adults: 2, children: 0, bags: 1, customer },
    total: 21900, amountDueNow: 21900, currency: 'USD', distanceKm: 120, durationMin: null, channel: 'whatsapp',
  } as never, { idempotencyKey: 'k-old' });
  const ctx = { source: 'quote_conversion', actorType: 'customer', actorId: 'x', relatedEntityType: 'quote', relatedEntityId: 'q1' } as const;
  if (status !== 'draft') await bookings.setStatus(b.id, 'payment_pending', undefined, ctx);
  if (status === 'paid' || status === 'confirmed') await bookings.setStatus(b.id, 'paid', undefined, ctx);
  if (status === 'confirmed') await bookings.setStatus(b.id, 'confirmed', undefined, ctx);
  return { bookings, payments, b, deps: { bookings, payments, quoteId: 'q1', requestId: 'req-1' } };
}

describe('cancelSupersededBooking', () => {
  it.each(['draft', 'payment_pending'] as const)('cancels a %s booking with no payment, recording why', async (status) => {
    const { bookings, b, deps } = await setup(status);
    const out = await cancelSupersededBooking(b.id, deps);
    expect(out?.status).toBe('cancelled');
    const after = (await bookings.get(b.id))!;
    expect(after.status).toBe('cancelled');
    expect(after.cancellationReason).toBe('superseded by a newer pay link');
    expect(after.cancelledBy).toBe(SUPERSEDED_BY);
    const events = await bookings.listStatusEvents(b.id);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ toStatus: 'cancelled', source: 'quote_conversion', actorType: 'system', reason: 'superseded by a newer pay link', relatedEntityType: 'quote', relatedEntityId: 'q1', requestId: 'req-1' });
  });

  it('NEVER cancels a booking that has a succeeded payment, whatever its status says', async () => {
    const { bookings, payments, b, deps } = await setup('payment_pending');
    const p = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: `${b.reference}-1`, amount: 21900, currency: 'USD', idempotencyKey: 'pay-1' });
    await payments.markSucceeded(p.id);
    expect(await cancelSupersededBooking(b.id, deps)).toBeNull();
    expect((await bookings.get(b.id))!.status).toBe('payment_pending');
  });

  it.each(['paid', 'confirmed'] as const)('never touches a %s booking', async (status) => {
    const { bookings, b, deps } = await setup(status);
    expect(await cancelSupersededBooking(b.id, deps)).toBeNull();
    expect((await bookings.get(b.id))!.status).toBe(status);
  });

  it('is a no-op for an unknown booking id', async () => {
    const { deps } = await setup('draft');
    expect(await cancelSupersededBooking('00000000-0000-4000-8000-000000000000', deps)).toBeNull();
  });
});
