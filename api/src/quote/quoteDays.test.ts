import { describe, it, expect } from 'vitest';
import { quoteDays } from './quoteDays';

const q = (legs: unknown[]) => ({ request: { tool: { legs } } });

describe('quoteDays', () => {
  it('renders a journey row with distance and duration, never a price', () => {
    const rows = quoteDays(q([{ from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 }]));
    expect(rows).toHaveLength(1);
    // 2026-08-20 is a Thursday (confirmed against payPageCopy.test.ts's own golden assertion
    // for the same date), not the Wednesday the original brief's test guessed.
    expect(rows[0]).toMatchObject({ kind: 'journey', date: 'THU 20 AUG', title: 'Colombo Airport → Sigiriya' });
    expect(rows[0].meta).toBe('168 km · about 4 h');
    expect(JSON.stringify(rows)).not.toMatch(/\$|cents|price/i);
  });

  it('synthesizes the days between legs as stays at the last place reached', () => {
    const rows = quoteDays(q([
      { from: 'Colombo', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
      { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
    ]));
    expect(rows.map((r) => r.title)).toEqual(['Colombo → Sigiriya', 'In Sigiriya', 'Sigiriya → Kandy']);
    // 2026-08-21 is a Friday — see the dating note above.
    expect(rows[1]).toMatchObject({ kind: 'stay', date: 'FRI 21 AUG', meta: null });
  });

  it('collapses consecutive synthesized stays into one range row', () => {
    const rows = quoteDays(q([
      { from: 'Kandy', to: 'Ella', date: '2026-08-24', distanceKm: 140 },
      { from: 'Ella', to: 'Colombo Airport', date: '2026-08-28', distanceKm: 212 },
    ]));
    expect(rows.map((r) => r.title)).toEqual(['Kandy → Ella', 'In Ella', 'Ella → Colombo Airport']);
    // 2026-08-25 is a Tuesday and 2026-08-27 a Thursday (see the dating note above).
    // rangeStamp() stamps both ends in full — it never drops a repeated month — so the range
    // reads 'TUE 25 AUG – THU 27 AUG', not the brief's 'MON 25 – WED 27 AUG' shorthand.
    expect(rows[1].date).toBe('TUE 25 AUG – THU 27 AUG');
  });

  it('renders an explicit stay_day leg as a stay', () => {
    const rows = quoteDays(q([
      { from: 'Colombo', to: 'Ella', date: '2026-08-20', distanceKm: 200 },
      { category: 'stay_day', from: 'Ella', to: 'Ella', date: '2026-08-21' },
    ]));
    expect(rows[1]).toMatchObject({ kind: 'stay', title: 'In Ella', meta: null });
  });

  it('uses the stop chain for a multi-stop leg and exposes the intermediates', () => {
    const rows = quoteDays(q([
      { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92, stops: ['Sigiriya', 'Dambulla', 'Matale', 'Kandy'] },
    ]));
    expect(rows[0].title).toBe('Sigiriya → Kandy');
    expect(rows[0].stops).toEqual(['Dambulla', 'Matale']);
  });

  it('skips synthesis entirely when any leg is undated', () => {
    const rows = quoteDays(q([
      { from: 'Colombo', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
      { from: 'Sigiriya', to: 'Kandy', distanceKm: 92 },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'journey')).toBe(true);
    expect(rows[1].date).toBe('');
  });

  it('returns [] for a legacy row with no tool legs', () => {
    expect(quoteDays({ request: {} })).toEqual([]);
  });

  // 121 km rounds to 173 minutes → h=2, remainder 53 → rounds to the NEXT 15-minute tick,
  // landing exactly on 60. Without carrying that into the hour, this reads "about 2 h" —
  // silently an hour short of the honest "about 3 h".
  it('carries a 60-minute rounding remainder into the next hour', () => {
    const rows = quoteDays(q([{ from: 'Colombo', to: 'Badulla', date: '2026-08-20', distanceKm: 121 }]));
    expect(rows[0].meta).toBe('121 km · about 3 h');
  });
});
