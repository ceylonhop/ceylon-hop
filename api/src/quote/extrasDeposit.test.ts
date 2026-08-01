import { describe, it, expect } from 'vitest';
import { priceExtras, depositCents } from './extrasDeposit';

describe('priceExtras', () => {
  it('sums known extras (sightseeing $10 + safari-wait $19 = $29)', () => {
    const r = priceExtras(['sightseeing', 'safari-wait']);
    expect(r.subtotalCents).toBe(2900);
    expect(r.lineItems).toHaveLength(2);
  });
  it('prices waiting extra ($10)', () => {
    expect(priceExtras(['waiting']).subtotalCents).toBe(1000);
  });
  it('throws on an unknown extra code', () => {
    // @ts-expect-error invalid code on purpose
    expect(() => priceExtras(['bogus'])).toThrow('UNKNOWN_EXTRA');
  });
});

describe('depositCents', () => {
  it('10% under the cap ($400 → $40)', () => {
    expect(depositCents(40000)).toBe(4000);
  });
  it('caps at $50 ($867 → $50, not $86.70)', () => {
    expect(depositCents(86700)).toBe(5000);
  });
  it('cap boundary: exactly $500 total (50000¢) → deposit exactly $50 (5000¢)', () => {
    expect(depositCents(50000)).toBe(5000);
  });
  it('cap boundary: 49990¢ total → deposit 4999¢ (just under cap)', () => {
    expect(depositCents(49990)).toBe(4999);
  });
});

describe('priceExtras attribution', () => {
  it('names the leg when legIndex resolves against legNames', () => {
    const r = priceExtras([{ code: 'sightseeing', legIndex: 1 }], undefined, ['Colombo → Kandy', 'Kandy → Ella']);
    expect(r.lineItems).toEqual([
      {
        label: 'Sightseeing stops (up to 3h) — Kandy → Ella',
        amountCents: 1000,
        meta: { kind: 'extra', code: 'sightseeing', legIndex: 1 },
      },
    ]);
    expect(r.subtotalCents).toBe(1000);
  });

  it('two attributed extras name DIFFERENT legs and still total 2x', () => {
    const r = priceExtras(
      [{ code: 'sightseeing', legIndex: 0 }, { code: 'sightseeing', legIndex: 2 }],
      undefined,
      ['Colombo → Kandy', 'Kandy → Ella', 'Ella → Yala'],
    );
    expect(r.lineItems.map((li) => li.label)).toEqual([
      'Sightseeing stops (up to 3h) — Colombo → Kandy',
      'Sightseeing stops (up to 3h) — Ella → Yala',
    ]);
    expect(r.subtotalCents).toBe(2000);
  });

  it('a bare ExtraCode is byte-identical to today — no meta, no leg name', () => {
    const r = priceExtras(['sightseeing']);
    expect(r.lineItems).toEqual([{ label: 'Sightseeing stops (up to 3h)', amountCents: 1000 }]);
  });

  it('legIndex with no resolvable name keeps the bare label but still records meta', () => {
    const r = priceExtras([{ code: 'waiting', legIndex: 7 }], undefined, ['Colombo → Kandy']);
    expect(r.lineItems[0].label).toBe('Waiting fee');
    expect(r.lineItems[0].meta).toEqual({ kind: 'extra', code: 'waiting', legIndex: 7 });
  });

  it('rejects an unknown code in the attributed shape too', () => {
    // @ts-expect-error - deliberately invalid code
    expect(() => priceExtras([{ code: 'bogus', legIndex: 0 }])).toThrow('UNKNOWN_EXTRA');
  });
});
