import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers } from './_load.js';

// repriceDecision keeps the "fixed price" promise: cheaper/equal routes apply,
// dearer-but-within-buffer holds the anchor, dearer-past-buffer needs a heads-up.
// Buffer is the +10% already priced into every leg (legPrice does round(km×1.10)).
let T;
beforeAll(() => { T = loadTransfers(); });

describe('repriceDecision', () => {
  it('applies a cheaper routed price (good news)', () => {
    // legPrice(200,'car') = round(round(200×1.10)×0.46) = round(220×0.46) = 101
    const d = T.repriceDecision(240, 200, 121, 'car');
    expect(d).toEqual({ action: 'apply', price: 101 });
  });

  it('holds the anchor when dearer but inside the +10% buffer', () => {
    // anchor 200 → billable 220. routed 210 ≤ 220 → hold, even though legPrice(210)=106 > 101.
    const d = T.repriceDecision(200, 210, 101, 'car');
    expect(d).toEqual({ action: 'hold', price: 101 });
  });

  it('holds exactly at the buffer boundary', () => {
    // round(200×1.10) = 220; routed 220 is still inside → hold.
    const d = T.repriceDecision(200, 220, 101, 'car');
    expect(d).toEqual({ action: 'hold', price: 101 });
  });

  it('confirms a material increase past the buffer', () => {
    // routed 300 > 220, legPrice(300,'car') = round(330×0.46) = 152 > 101 → confirm, extra 100 km.
    const d = T.repriceDecision(200, 300, 101, 'car');
    expect(d).toEqual({ action: 'confirm', price: 152, extraKm: 100 });
  });

  it('uses the van rate for van quotes', () => {
    // legPrice(300,'van') = round(330×0.83) = 274 > 190 → confirm.
    const d = T.repriceDecision(200, 300, 190, 'van');
    expect(d).toEqual({ action: 'confirm', price: 274, extraKm: 100 });
  });

  it('never lets extraKm fall below 1 km', () => {
    // Contrived: dearer past buffer but tiny km delta → floor extraKm at 1.
    const d = T.repriceDecision(1, 2, 1, 'car');
    expect(d.action).toBe('confirm');
    expect(d.extraKm).toBeGreaterThanOrEqual(1);
  });

  it('falls back to apply when there is no baseline distance', () => {
    const d = T.repriceDecision(null, 300, 101, 'car');
    expect(d).toEqual({ action: 'apply', price: 152 });
  });
});
