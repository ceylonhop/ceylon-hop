import { describe, it, expect } from 'vitest';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { FakeTokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import { FakeEmailAdapter } from '../adapters/email';
import { runRideBoardCutoff } from './rideBoardCutoff';

const PAST = new Date('2026-08-06T01:30:00Z');
const NOW = new Date('2026-08-07T00:00:00Z'); // after PAST

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-08-08', slot: 'morning',
  minSeats: 4, capacity: 6, seatPrice: 2400, note: null, cutoffAt: PAST, createdBy: null, ...over,
});

const joiner = (sub: string, ref: string, preferredTime: string | null = null) => ({
  sub, firstName: sub.toUpperCase(), country: 'LK', email: `${sub}@x.com`, seats: 1, preapprovalRef: ref, preferredTime,
});

async function fill(repo: InMemoryRideListRepo, listId: string, n: number, prefs: (string | null)[] = []) {
  for (let i = 0; i < n; i++) await repo.addMember(listId, joiner(`u${i}`, `pa_u${i}`, prefs[i] ?? null));
}

describe('runRideBoardCutoff', () => {
  it('confirms a full list: locks the popular time, charges every seat, emails everyone', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4, ['09:00', '09:00', '08:00', '09:00']);

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res).toMatchObject({ processed: 1, confirmed: 1, expired: 0, charged: 4, chargeFailed: 0 });

    const after = await repo.getByCode(list.code);
    expect(after?.list.status).toBe('confirmed');
    expect(after?.list.lockedTime).toBe('09:00'); // group's most-popular
    expect(after?.members.every((m) => m.status === 'charged')).toBe(true);
    expect(paygw.charges).toHaveLength(4);
    expect(paygw.charges[0].amountCents).toBe(2400);
    expect(email.sent.filter((e) => /confirmed/i.test(e.subject))).toHaveLength(4);
  });

  it('expires an under-filled list: nobody charged, everyone gets options', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 2);

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res).toMatchObject({ processed: 1, confirmed: 0, expired: 1, charged: 0 });
    expect((await repo.getByCode(list.code))?.list.status).toBe('expired');
    expect(paygw.charges).toHaveLength(0);
    expect(email.sent.filter((e) => /didn't fill/i.test(e.subject))).toHaveLength(2);
  });

  it('still confirms when one card declines, and emails the at-risk traveller', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs({ minSeats: 4, capacity: 6 }));
    await fill(repo, list.id, 5); // 5 held, one will decline → 4 still charge (== minSeats)
    paygw.markRefWillFail('pa_u4');

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res).toMatchObject({ confirmed: 1, charged: 4, chargeFailed: 1 });
    const after = await repo.getByCode(list.code);
    expect(after?.list.status).toBe('confirmed');
    expect(after?.members.find((m) => m.sub === 'u4')?.status).toBe('charge_failed');
    expect(email.sent.some((e) => /at risk/i.test(e.subject))).toBe(true);
  });

  it('ignores lists whose cutoff has not passed', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const future = await repo.createList(listArgs({ cutoffAt: new Date('2026-09-01T00:00:00Z') }));
    await fill(repo, future.id, 4);

    const res = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(res.processed).toBe(0);
    expect((await repo.getByCode(future.code))?.list.status).toBe('gathering');
  });

  it('is idempotent — a second run does nothing (list no longer gathering)', async () => {
    const repo = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const email = new FakeEmailAdapter();
    const list = await repo.createList(listArgs());
    await fill(repo, list.id, 4);
    await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    const second = await runRideBoardCutoff(NOW, { rideLists: repo, paygw, email });
    expect(second.processed).toBe(0);
    expect(paygw.charges).toHaveLength(4); // not charged again
  });
});
