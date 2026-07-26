import { describe, it, expect, vi, afterEach } from 'vitest';
import { runRideBoardCutoff } from './rideBoardCutoff';
import { InMemoryRideListRepo } from '../db/rideListRepo';
import { FakeTokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import { FakeEmailAdapter } from '../adapters/email';

// ────────────────────────────────────────────────────────────────────────────
//  Ride-board telemetry (2026-07-26).
//
//  The cutoff sweep is where a van either runs or is called off, and it happens
//  on a cron tick with nobody watching. These pin that both outcomes leave a
//  structured, greppable trace — including the one that costs real money: cards
//  charged on a van that then got cancelled.
// ────────────────────────────────────────────────────────────────────────────

afterEach(() => vi.restoreAllMocks());

/** Capture the structured event lines emitted during `fn`. */
async function events(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => {
    try { lines.push(JSON.parse(String(s))); } catch { /* not one of ours */ }
  });
  await fn();
  return lines.filter((l) => String(l.event ?? '').startsWith('ride_board.'));
}

const PAST_CUTOFF = new Date('2027-03-20T00:00:00Z');

async function seedList(repo: InMemoryRideListRepo, minSeats = 3) {
  return repo.createList({
    corridorId: 'south-coast', fromPlace: 'Ella', toPlace: 'Mirissa',
    date: '2027-03-22', slot: 'morning', minSeats, capacity: 6, seatPrice: 2450,
    note: null, cutoffAt: new Date('2027-03-19T12:30:00Z'), createdBy: 'sub-a',
  });
}
async function addName(repo: InMemoryRideListRepo, listId: string, sub: string, seats = 1) {
  return repo.addMember(listId, {
    sub, firstName: 'Ann', country: 'GB', email: `${sub}@example.com`,
    photoUrl: null, preferredTime: null, seats, preapprovalRef: `pre-${sub}`,
  });
}

function deps(rideLists: InMemoryRideListRepo, paygw = new FakeTokenizedPaymentAdapter()) {
  return { rideLists, paygw, email: new FakeEmailAdapter(), currency: 'USD' };
}

describe('cutoff sweep telemetry', () => {
  it('records a confirmed van with the seats and the money it earned', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await seedList(repo);
    await addName(repo, list.id, 'a');
    await addName(repo, list.id, 'b');
    await addName(repo, list.id, 'c');

    const fired = await events(() => runRideBoardCutoff(PAST_CUTOFF, deps(repo)));
    const confirmed = fired.find((e) => e.event === 'ride_board.confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed).toMatchObject({ code: list.code, seats: 3, minSeats: 3 });
    expect(confirmed!.revenueCents).toBe(2450 * 3);
    expect(typeof confirmed!.lockedTime).toBe('string');
  });

  it('records a van called off for want of names, and says so', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await seedList(repo);
    await addName(repo, list.id, 'a');

    const fired = await events(() => runRideBoardCutoff(PAST_CUTOFF, deps(repo)));
    const off = fired.find((e) => e.event === 'ride_board.called_off');
    expect(off).toBeDefined();
    expect(off).toMatchObject({ code: list.code, reason: 'below_threshold', minSeats: 3 });
  });

  it('never puts a traveller email or subject in a telemetry line', async () => {
    const repo = new InMemoryRideListRepo();
    const list = await seedList(repo);
    await addName(repo, list.id, 'private-sub-999');
    await addName(repo, list.id, 'b');
    await addName(repo, list.id, 'c');

    const fired = await events(() => runRideBoardCutoff(PAST_CUTOFF, deps(repo)));
    const blob = JSON.stringify(fired);
    expect(blob).not.toContain('@example.com');
    expect(blob).not.toContain('private-sub-999');
  });

  it('emits nothing when no van is due', async () => {
    const repo = new InMemoryRideListRepo();
    const fired = await events(() => runRideBoardCutoff(new Date('2027-01-01T00:00:00Z'), deps(repo)));
    expect(fired).toEqual([]);
  });
});
