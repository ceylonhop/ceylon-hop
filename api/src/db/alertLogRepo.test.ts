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
