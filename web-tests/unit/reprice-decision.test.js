import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers } from './_load.js';

// repriceDecision enforces a FIRM FLOOR: the quoted price never drops. Cheaper/equal
// routes and within-buffer changes hold the quote; only a material increase past the
// per-leg buffered billable km prompts a heads-up. Buffer is the same clamp already
// priced into every leg (legPrice uses km + clamp(round(km×0.10), 5, 15)).
let T;
beforeAll(() => { T = loadTransfers(); });

describe('repriceDecision', () => {
  it('holds the quote for a cheaper routed price (firm floor — never drops)', () => {
    // legPrice(200,'car') = round(215×0.4025) = 87 < 121,
    // but the firm floor keeps the quoted $121.
    const d = T.repriceDecision(240, 200, 121, 'car');
    expect(d).toEqual({ action: 'hold', price: 121 });
  });

  it('holds the anchor when dearer but inside the billed buffer', () => {
    // anchor 200 → billable 215. routed 210 ≤ 215 → hold, even though legPrice(210)=91 > 87.
    const d = T.repriceDecision(200, 210, 101, 'car');
    expect(d).toEqual({ action: 'hold', price: 101 });
  });

  it('holds exactly at the buffer boundary', () => {
    // billableKm(200) = 215; routed 215 is still inside → hold.
    const d = T.repriceDecision(200, 215, 101, 'car');
    expect(d).toEqual({ action: 'hold', price: 101 });
  });

  it('confirms a material increase past the buffer', () => {
    // routed 300 > 215, exact legPrice(300,'car') = $126.79 > $101 → confirm, extra 100 km.
    const d = T.repriceDecision(200, 300, 101, 'car');
    expect(d).toEqual({ action: 'confirm', price: 126.79, extraKm: 100 });
  });

  it('uses the van rate for van quotes', () => {
    // legPrice(300,'van') = round(315×0.5405) = 170 < 190 anchor → firm floor holds.
    const d = T.repriceDecision(200, 300, 190, 'van');
    expect(d).toEqual({ action: 'hold', price: 190 });
  });

  it('holds tiny route changes inside the 5km minimum buffer', () => {
    // anchor 1 → billable 6 via the 5km minimum buffer, so routed 2 is still inside → hold.
    const d = T.repriceDecision(1, 2, 1, 'car');
    expect(d).toEqual({ action: 'hold', price: 1 });
  });

  it('holds the quote when there is no baseline distance (firm floor)', () => {
    const d = T.repriceDecision(null, 300, 101, 'car');
    expect(d).toEqual({ action: 'hold', price: 101 });
  });
});
