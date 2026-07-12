import { describe, it, expect } from 'vitest';
import { InMemoryAlertLogRepo } from './alertLogRepo';

describe('InMemoryAlertLogRepo', () => {
  const COOLDOWN = 30 * 60_000;

  it('first shouldSend is true, repeats inside the cooldown are false', async () => {
    const repo = new InMemoryAlertLogRepo();
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(0))).toBe(true);
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(10_000))).toBe(false);
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(29 * 60_000))).toBe(false);
  });

  it('sends again once the cooldown has passed', async () => {
    const repo = new InMemoryAlertLogRepo();
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(0))).toBe(true);
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(31 * 60_000))).toBe(true);
  });

  it('keys are independent per (kind, dedupeKey)', async () => {
    const repo = new InMemoryAlertLogRepo();
    expect(await repo.shouldSend('a', 'x', COOLDOWN, new Date(0))).toBe(true);
    expect(await repo.shouldSend('b', 'x', COOLDOWN, new Date(0))).toBe(true);
    expect(await repo.shouldSend('a', 'y', COOLDOWN, new Date(0))).toBe(true);
  });

  // BI3 — a reservation whose delivery later fails is rolled back, so the alert isn't
  // suppressed for a whole cooldown and the failed send is never counted as delivered.
  it('rollback frees a reservation so the next shouldSend re-sends inside the cooldown', async () => {
    const repo = new InMemoryAlertLogRepo();
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(1_000))).toBe(true);
    await repo.rollback('k', 'x', new Date(1_000));
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(2_000))).toBe(true);
  });

  it('rollback ignores a reservation it does not own (timestamp mismatch)', async () => {
    const repo = new InMemoryAlertLogRepo();
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(1_000))).toBe(true);
    await repo.rollback('k', 'x', new Date(999)); // not the reserved-at → no-op
    expect(await repo.shouldSend('k', 'x', COOLDOWN, new Date(2_000))).toBe(false);
  });

  it('a rolled-back reservation is not counted by countsSince', async () => {
    const repo = new InMemoryAlertLogRepo();
    await repo.shouldSend('payments', 'b1', COOLDOWN, new Date(1_000));
    await repo.rollback('payments', 'b1', new Date(1_000));
    expect(await repo.countsSince(new Date(0))).toEqual({});
  });

  it('countsSince aggregates delivered alerts per kind within the window', async () => {
    const repo = new InMemoryAlertLogRepo();
    await repo.shouldSend('payments', 'b1', COOLDOWN, new Date(1_000));
    await repo.shouldSend('payments', 'b2', COOLDOWN, new Date(2_000));
    await repo.shouldSend('errors', 'e1', COOLDOWN, new Date(3_000));
    await repo.shouldSend('payments', 'b1', COOLDOWN, new Date(4_000)); // suppressed — not counted
    expect(await repo.countsSince(new Date(0))).toEqual({ payments: 2, errors: 1 });
    expect(await repo.countsSince(new Date(2_500))).toEqual({ errors: 1 });
  });
});
