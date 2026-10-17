import { describe, it, expect, vi } from 'vitest';
import { UsageMeter, utcDay } from './usageMeter';
import { InMemoryUsageCounterRepo, type UsageCounterRepo } from '../db/usageCounterRepo';

// Usage counters (spec 2026-10-13 §2): count in memory, write coalesced. A burst of a
// thousand 429s must cost one row write per flush, not a thousand.

const T0 = new Date('2026-10-13T10:00:00.000Z');

function meterWith(repo: UsageCounterRepo, now = () => T0) {
  // No timer in tests: flush() is called explicitly.
  return new UsageMeter(repo, { now, flushMs: 0 });
}

describe('utcDay', () => {
  it('keys a counter by its UTC calendar day', () => {
    expect(utcDay(new Date('2026-10-13T23:59:59.999Z'))).toBe('2026-10-13');
    expect(utcDay(new Date('2026-10-14T00:00:00.000Z'))).toBe('2026-10-14');
  });
});

describe('UsageMeter', () => {
  it('accumulates bumps in memory and writes one row per (day, key) on flush', async () => {
    const repo = new InMemoryUsageCounterRepo();
    const add = vi.spyOn(repo, 'add');
    const meter = meterWith(repo);
    for (let i = 0; i < 1000; i++) meter.bump('ratelimit.refused');
    meter.bump('email.sent', 3);
    expect(add).not.toHaveBeenCalled();

    await meter.flush();
    expect(add).toHaveBeenCalledTimes(2);
    const rows = await repo.range('2026-10-13', '2026-10-13');
    expect(rows).toEqual(expect.arrayContaining([
      { day: '2026-10-13', key: 'ratelimit.refused', n: 1000 },
      { day: '2026-10-13', key: 'email.sent', n: 3 },
    ]));
  });

  it('adds to an existing row rather than replacing it', async () => {
    const repo = new InMemoryUsageCounterRepo();
    const meter = meterWith(repo);
    meter.bump('email.sent');
    await meter.flush();
    meter.bump('email.sent', 2);
    await meter.flush();
    expect(await repo.range('2026-10-13', '2026-10-13')).toEqual([{ day: '2026-10-13', key: 'email.sent', n: 3 }]);
  });

  it('splits counts across UTC days as the clock crosses midnight', async () => {
    const repo = new InMemoryUsageCounterRepo();
    let now = new Date('2026-10-13T23:59:59.000Z');
    const meter = meterWith(repo, () => now);
    meter.bump('maps.distance');
    now = new Date('2026-10-14T00:00:01.000Z');
    meter.bump('maps.distance');
    await meter.flush();
    expect(await repo.range('2026-10-13', '2026-10-14')).toEqual([
      { day: '2026-10-13', key: 'maps.distance', n: 1 },
      { day: '2026-10-14', key: 'maps.distance', n: 1 },
    ]);
  });

  it('keeps pending counts when the write fails, and retries them on the next flush', async () => {
    const repo = new InMemoryUsageCounterRepo();
    const add = vi.spyOn(repo, 'add').mockRejectedValueOnce(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const meter = meterWith(repo);
    meter.bump('email.sent');
    await meter.flush(); // fails, nothing written, nothing lost
    expect(await repo.range('2026-10-13', '2026-10-13')).toEqual([]);
    meter.bump('email.sent');
    await meter.flush();
    expect(await repo.range('2026-10-13', '2026-10-13')).toEqual([{ day: '2026-10-13', key: 'email.sent', n: 2 }]);
    expect(add).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('a flush with nothing pending writes nothing', async () => {
    const repo = new InMemoryUsageCounterRepo();
    const add = vi.spyOn(repo, 'add');
    await meterWith(repo).flush();
    expect(add).not.toHaveBeenCalled();
  });

  it('arms one timer per burst and flushes on it', async () => {
    vi.useFakeTimers();
    try {
      const repo = new InMemoryUsageCounterRepo();
      const add = vi.spyOn(repo, 'add');
      const meter = new UsageMeter(repo, { now: () => T0, flushMs: 10_000 });
      meter.bump('email.sent');
      meter.bump('email.sent');
      expect(add).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(add).toHaveBeenCalledTimes(1);
      expect(await repo.range('2026-10-13', '2026-10-13')).toEqual([{ day: '2026-10-13', key: 'email.sent', n: 2 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
