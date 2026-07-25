import { describe, it, expect } from 'vitest';
import { InMemoryRideListRepo, type CreateListArgs } from './rideListRepo';

const baseList = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south',
  fromPlace: 'Ella',
  toPlace: 'Mirissa',
  date: '2026-08-08',
  slot: 'morning',
  minSeats: 4,
  capacity: 6,
  seatPrice: 2400,
  note: null,
  cutoffAt: new Date('2026-08-06T01:30:00Z'),
  createdBy: 'creator-sub',
  ...over,
});

const joiner = (sub: string, seats = 1) => ({
  sub, firstName: sub, country: 'LK', email: `${sub}@x.com`, seats,
});

describe('InMemoryRideListRepo — create & read', () => {
  it('creates a list with a public code and finds it by code', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList());
    expect(list.code).toMatch(/^EM-\d{4}$/);
    expect(list.status).toBe('gathering');
    const found = await repo.getByCode(list.code);
    expect(found?.list.id).toBe(list.id);
    expect(found?.members).toEqual([]);
  });

  it('gives each list a distinct code', async () => {
    const repo = new InMemoryRideListRepo();
    const a = await repo.createList(baseList());
    const b = await repo.createList(baseList());
    expect(a.code).not.toBe(b.code);
  });
});

describe('InMemoryRideListRepo — membership', () => {
  it('adds members with 1-based positions', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList());
    const m1 = await repo.addMember(list.id, joiner('a'));
    const m2 = await repo.addMember(list.id, joiner('b'));
    expect(m1?.position).toBe(1);
    expect(m2?.position).toBe(2);
    expect(m2?.status).toBe('held');
  });

  it('is idempotent for a live member (no double-add)', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList());
    await repo.addMember(list.id, joiner('a'));
    const again = await repo.addMember(list.id, joiner('a'));
    expect(again?.position).toBe(1);
    expect((await repo.getByCode(list.code))?.members).toHaveLength(1);
  });

  it('refuses to exceed van capacity (no oversell)', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList({ capacity: 3 }));
    expect(await repo.addMember(list.id, joiner('a', 2))).not.toBeNull();
    expect(await repo.addMember(list.id, joiner('b', 2))).toBeNull(); // 2+2 > 3
    expect(await repo.addMember(list.id, joiner('c', 1))).not.toBeNull(); // 2+1 = 3 ok
  });

  it('never oversells under concurrent joins', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList({ capacity: 5 }));
    const attempts = Array.from({ length: 20 }, (_, i) => repo.addMember(list.id, joiner(`u${i}`, 1)));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r !== null)).toHaveLength(5);
  });

  it('scratches a name off and frees the seat for someone else', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList({ capacity: 2 }));
    await repo.addMember(list.id, joiner('a'));
    await repo.addMember(list.id, joiner('b'));
    expect(await repo.addMember(list.id, joiner('c'))).toBeNull(); // full
    expect(await repo.removeMember(list.id, 'b')).toBe(true);
    expect(await repo.addMember(list.id, joiner('c'))).not.toBeNull(); // seat freed & reused
  });

  it('lets a scratched member re-join into their original position when there is room', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList({ capacity: 6 }));
    await repo.addMember(list.id, joiner('a'));
    await repo.addMember(list.id, joiner('b'));
    await repo.addMember(list.id, joiner('c'));
    await repo.removeMember(list.id, 'b');
    const b = await repo.addMember(list.id, joiner('b'));
    expect(b?.position).toBe(2); // original position kept
    expect((await repo.getByCode(list.code))?.members.filter((m) => m.status === 'held')).toHaveLength(3);
  });

  it('removeMember on an absent sub returns false', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList());
    expect(await repo.removeMember(list.id, 'ghost')).toBe(false);
  });
});

// A confirmed van stays on the board: it proves the mechanism works, it may still have seats,
// and when it is full it is the prompt to start the next van on that route. Only cancelled and
// expired lists drop off, because there is nothing left to join or copy.
describe('InMemoryRideListRepo — what stays on the board', () => {
  it('keeps confirmed lists, including full ones, and drops cancelled/expired', async () => {
    const repo = new InMemoryRideListRepo();
    const gathering = await repo.createList(baseList({ fromPlace: 'Ella', toPlace: 'Mirissa' }));
    const confirmed = await repo.createList(baseList({ fromPlace: 'Kandy', toPlace: 'Ella', corridorId: 'hill-line' }));
    const cancelled = await repo.createList(baseList({ fromPlace: 'Yala', toPlace: 'Galle', corridorId: 'yala-south' }));
    const expired = await repo.createList(baseList({ fromPlace: 'Galle', toPlace: 'Mirissa', corridorId: 'south-coast' }));
    await repo.setStatus(confirmed.id, 'confirmed');
    await repo.setStatus(cancelled.id, 'cancelled');
    await repo.setStatus(expired.id, 'expired');

    const codes = (await repo.listOpen()).map((r) => r.list.code);
    expect(codes).toContain(gathering.code);
    expect(codes).toContain(confirmed.code);
    expect(codes).not.toContain(cancelled.code);
    expect(codes).not.toContain(expired.code);
  });
});

describe('InMemoryRideListRepo — filters & dedupe', () => {
  it('lists only gathering lists, filtered by from-city', async () => {
    const repo = new InMemoryRideListRepo();
    await repo.createList(baseList({ fromPlace: 'Ella', toPlace: 'Mirissa' }));
    await repo.createList(baseList({ fromPlace: 'Kandy', toPlace: 'Ella', corridorId: 'hill-line' }));
    const ella = await repo.listOpen({ from: 'ella' });
    expect(ella).toHaveLength(1);
    expect(ella[0].list.fromPlace).toBe('Ella');
  });

  it('filters by date window (this week)', async () => {
    const repo = new InMemoryRideListRepo();
    const now = new Date('2026-08-01T00:00:00Z');
    await repo.createList(baseList({ date: '2026-08-04' })); // +3d
    await repo.createList(baseList({ date: '2026-08-20', fromPlace: 'Kandy' })); // +19d
    expect(await repo.listOpen({ when: 'week' }, now)).toHaveLength(1);
    expect(await repo.listOpen({ when: 'fortnight' }, now)).toHaveLength(1);
    expect(await repo.listOpen({}, now)).toHaveLength(2);
  });

  it('finds an open list on the same route (dedupe)', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList());
    const dup = await repo.findOpenByRoute('ella', 'mirissa');
    expect(dup?.id).toBe(list.id);
    expect(await repo.findOpenByRoute('kandy', 'ella')).toBeNull();
  });

  // A confirmed list stays VISIBLE on the board but stops being a dedupe target — that pairing is
  // what lets a traveller start a second van on a route whose first van is already locked in.
  it('a confirmed list stays on the board but no longer blocks a new list on the same route', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList());
    await repo.setStatus(list.id, 'confirmed');
    expect(await repo.listOpen()).toHaveLength(1);
    expect(await repo.findOpenByRoute('ella', 'mirissa')).toBeNull();
  });
});

describe('InMemoryRideListRepo — lock & cutoff', () => {
  it('locks a departure time', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await repo.createList(baseList());
    await repo.lockDeparture(list.id, '08:00');
    expect((await repo.getById(list.id))?.list.lockedTime).toBe('08:00');
  });

  it('returns gathering lists past their cutoff', async () => {
    const repo = new InMemoryRideListRepo();
    await repo.createList(baseList({ cutoffAt: new Date('2026-08-06T01:30:00Z') }));
    await repo.createList(baseList({ fromPlace: 'Kandy', cutoffAt: new Date('2026-09-01T00:00:00Z') }));
    const due = await repo.dueForCutoff(new Date('2026-08-07T00:00:00Z'));
    expect(due).toHaveLength(1);
    expect(due[0].list.fromPlace).toBe('Ella');
  });
});
