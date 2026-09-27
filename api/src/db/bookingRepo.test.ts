import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo, type NewBooking, personKeyFor } from './bookingRepo';
import type { BookingTransitionContext } from '../domain/trackingContract';

const sample: NewBooking = {
  mode: 'single',
  input: {
    from: 'A',
    to: 'B',
    vehicleType: 'car',
    adults: 1,
    children: 0,
    bags: 0,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 4000,
  amountDueNow: 4000,
  currency: 'USD',
};

const websiteCustomer: BookingTransitionContext = {
  source: 'website',
  actorType: 'customer',
  actorId: 'maya@example.com',
  requestId: '11111111-1111-4111-8111-111111111111',
};

describe('InMemoryBookingRepo', () => {
  it('creates bookings with unique ids and CH- references', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    const b = await repo.create(sample);
    expect(a.id).not.toBe(b.id);
    expect(a.reference).toMatch(/^CH-[A-Z2-9]{5}$/);
    expect(a.reference).not.toBe(b.reference);
    expect(a.status).toBe('draft');
  });

  it('gets a booking by id, and null for an unknown id', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    expect(await repo.get(a.id)).toEqual(a);
    expect(await repo.get('nope')).toBeNull();
  });

  it('returns the same booking for a repeated idempotency key', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample, { idempotencyKey: 'k1' });
    const b = await repo.create(sample, { idempotencyKey: 'k1' });
    expect(a.id).toBe(b.id);
  });

  it('applies a legal status transition', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    const updated = await repo.setStatus(a.id, 'payment_pending');
    expect(updated.status).toBe('payment_pending');
    expect((await repo.get(a.id))?.status).toBe('payment_pending');
  });

  it('keeps the transition ledger empty while the rollout flag is off', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    await repo.setStatus(a.id, 'payment_pending', undefined, websiteCustomer);
    expect(await repo.listStatusEvents(a.id)).toEqual([]);
  });

  it('atomically records one applied transition with its provenance when enabled', async () => {
    const repo = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
    const a = await repo.create(sample);

    await repo.setStatus(a.id, 'payment_pending', undefined, websiteCustomer);

    expect(await repo.listStatusEvents(a.id)).toMatchObject([
      {
        bookingId: a.id,
        fromStatus: 'draft',
        toStatus: 'payment_pending',
        source: 'website',
        actorType: 'customer',
        actorId: 'maya@example.com',
        requestId: '11111111-1111-4111-8111-111111111111',
        runId: null,
        reason: null,
        relatedEntityType: null,
        relatedEntityId: null,
      },
    ]);
  });

  it('records neither a baseline nor an illegal transition', async () => {
    const repo = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
    const a = await repo.create(sample);
    expect(await repo.listStatusEvents(a.id)).toEqual([]);

    await expect(
      repo.setStatus(a.id, 'completed', undefined, websiteCustomer),
    ).rejects.toThrow();
    expect((await repo.get(a.id))?.status).toBe('draft');
    expect(await repo.listStatusEvents(a.id)).toEqual([]);
  });

  it('lets only one concurrent transition win and records only that applied fact', async () => {
    const repo = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
    const a = await repo.create(sample);

    const results = await Promise.allSettled([
      repo.setStatus(a.id, 'payment_pending', undefined, websiteCustomer),
      repo.setStatus(a.id, 'payment_pending', undefined, websiteCustomer),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await repo.listStatusEvents(a.id)).toHaveLength(1);
  });

  it('returns status history in a stable applied order', async () => {
    const repo = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
    const a = await repo.create(sample);
    await repo.setStatus(a.id, 'payment_pending', undefined, websiteCustomer);
    await repo.setStatus(a.id, 'paid', undefined, {
      source: 'payment_webhook',
      actorType: 'provider',
      relatedEntityType: 'payment',
      relatedEntityId: 'pay-1',
      requestId: '22222222-2222-4222-8222-222222222222',
    });

    const first = await repo.listStatusEvents(a.id);
    const second = await repo.listStatusEvents(a.id);
    expect(second).toEqual(first);
    expect(first.map((event) => [event.fromStatus, event.toStatus])).toEqual([
      ['draft', 'payment_pending'],
      ['payment_pending', 'paid'],
    ]);
  });

  it('rejects an illegal transition and leaves the row unchanged', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    await expect(repo.setStatus(a.id, 'completed')).rejects.toThrow();
    expect((await repo.get(a.id))?.status).toBe('draft');
  });

  it('defaults channel to website', async () => {
    const repo = new InMemoryBookingRepo();
    const b = await repo.create(sample);
    expect(b.channel).toBe('website');
  });

  it('persists an explicit whatsapp channel', async () => {
    const repo = new InMemoryBookingRepo();
    const b = await repo.create({ ...sample, channel: 'whatsapp' });
    expect(b.channel).toBe('whatsapp');
  });

  it('is concurrency-safe on the idempotency key: two simultaneous creates yield one booking', async () => {
    const repo = new InMemoryBookingRepo();
    const [a, b] = await Promise.all([
      repo.create(sample, { idempotencyKey: 'k1' }),
      repo.create(sample, { idempotencyKey: 'k1' }),
    ]);
    expect(a.id).toBe(b.id);
    expect((await repo.list()).length).toBe(1);
  });
});

// Repeat customers, without merging their rows (owner, 2026-08-02). Prod held 10 customers
// rows for 5 actual people, so any repeat-guest view or customer count was wrong.
//
// The obvious fix — dedupe by email and reuse the row — would CORRUPT EXISTING BOOKINGS. A
// booking has no traveller of its own: the name is read off the linked customers row, and
// transfer_request/trip_request store places and dates but no name. Merging two rows rewrites
// the traveller on whichever booking wrote first. So we LINK instead: person_key groups them
// (generated in Postgres by migration 0032) and every booking keeps its own snapshot.
describe('personKeyFor — grouping people without merging rows', () => {
  it('matches the same human across casing and stray whitespace', () => {
    expect(personKeyFor('Roshen@CeylonHop.com')).toBe('roshen@ceylonhop.com');
    expect(personKeyFor('  roshen@ceylonhop.com  ')).toBe('roshen@ceylonhop.com');
    expect(personKeyFor('someone.else@x.com')).not.toBe(personKeyFor('roshen@ceylonhop.com'));
  });

  it('groups two bookings by one person while each KEEPS ITS OWN traveller name', async () => {
    const repo = new InMemoryBookingRepo();
    const base = {
      mode: 'single' as const, total: 4900, amountDueNow: 4900, currency: 'USD',
      input: { from: 'CMB', to: 'Galle', vehicleType: 'car' as const, adults: 1, children: 0, bags: 1,
        customer: { firstName: 'Frank', lastName: 'W', email: 'Roshen@CeylonHop.com', whatsapp: '+94770001111', country: 'LK' } },
    };
    const first = await repo.create(base);
    // Same person, booking for someone else this time — the name MUST NOT overwrite the first.
    const second = await repo.create({ ...base,
      input: { ...base.input, customer: { ...base.input.customer, firstName: 'Anja', email: 'roshen@ceylonhop.com  ' } } });

    expect(personKeyFor(first.input.customer.email)).toBe(personKeyFor(second.input.customer.email));
    expect((await repo.get(first.id))!.input.customer.firstName).toBe('Frank');
    expect((await repo.get(second.id))!.input.customer.firstName).toBe('Anja');
  });
});
