import { describe, it, expect } from 'vitest';
import { InMemoryPaymentRepo } from './paymentRepo.js';

/* Who took the money used to live ONLY in ride_ops.ops_notes ("Marked paid — cash · REF · by
   alice@…"). That field is writable through POST /admin/ops/bookings/:id/flags, which needs
   bookings:operate — held by the `ops` role, which is deliberately DENIED payments:act. So the
   one role not trusted to record money could erase the record of who recorded it. SH8 gave manual
   REFUNDS immutable requested_by/confirmed_by columns; manual capture shipped without them
   (docs/known-bugs.md, 2026-07-30). */

const seed = async () => {
  const repo = new InMemoryPaymentRepo();
  const p = await repo.create({
    bookingId: 'b-1', provider: 'cash', orderId: 'CH-ACTOR1',
    amount: 22900, currency: 'USD', idempotencyKey: 'k-1',
  });
  return { repo, p };
};

describe('a manual settlement records its actor in a column', () => {
  it('stores who recorded the money, alongside the provenance', async () => {
    const { repo, p } = await seed();
    await repo.markSucceededManually(p.id, { reference: 'BANK-9931', settledBy: 'finance@ceylonhop.com' });
    expect(await repo.settledByFor(p.id)).toBe('finance@ceylonhop.com');
    expect(await repo.hasManualSettlement('b-1')).toBe(true);
  });

  it('leaves gateway money with no actor — a webhook has no human to name', async () => {
    const { repo, p } = await seed();
    expect(await repo.settledByFor(p.id)).toBeNull();
  });

  it('the actor is not reachable from any ops-notes write — that is the whole point', async () => {
    const { repo, p } = await seed();
    await repo.markSucceededManually(p.id, { reference: null, settledBy: 'finance@ceylonhop.com' });
    // The actor has exactly ONE writer — the settlement itself — and one reader. Enumerated
    // rather than described, so adding a setter turns this red: an actor you can overwrite is
    // just the mutable ops note again, which is the bug this column exists to close.
    const touchingActor = Object.getOwnPropertyNames(Object.getPrototypeOf(repo))
      .filter((m) => /settledby|manually/i.test(m))
      .sort();
    expect(touchingActor).toEqual(['markSucceededManually', 'settledByFor']);
    expect(await repo.settledByFor(p.id)).toBe('finance@ceylonhop.com');
  });
});
