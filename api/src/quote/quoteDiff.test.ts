import { describe, it, expect } from 'vitest';
import { changedFields } from './quoteDiff';

const v = (over: Record<string, unknown> = {}, totalCents = 10000) => ({
  totalCents,
  request: {
    engine: {
      product: 'private', vehicle: 'car', pax: 2, bags: 1,
      legs: [{ stops: ['A', 'B'], segmentKms: [100] }],
      extras: [{ code: 'sightseeing', legIndex: 0 }],
      ...over,
    },
    tool: { legs: [{ date: '2026-09-01' }] },
  },
});

describe('changedFields', () => {
  it('reports nothing when nothing moved', () => {
    expect(changedFields(v(), v())).toEqual([]);
  });

  // The Q-DMKNW case: a fee came off, the price moved, the route did not.
  it('names extras and total when a fee is dropped', () => {
    expect(changedFields(v(), v({ extras: [] }, 9000)).sort()).toEqual(['extras', 'total']);
  });

  // The case the owner BELIEVED had happened: a pickup edit that leaves the price alone.
  it('names stops but NOT total when a pickup changes at the same price', () => {
    expect(changedFields(v(), v({ legs: [{ stops: ['A2', 'B'], segmentKms: [100] }] }))).toEqual(['stops']);
  });

  it('names distance when only the km move', () => {
    expect(changedFields(v(), v({ legs: [{ stops: ['A', 'B'], segmentKms: [120] }] }))).toEqual(['distance']);
  });

  it('names legs when a leg is added', () => {
    const next = v({ legs: [{ stops: ['A', 'B'], segmentKms: [100] }, { stops: ['B', 'C'], segmentKms: [50] }] });
    expect(changedFields(v(), next)).toContain('legs');
  });

  it('names vehicle, pax and bags', () => {
    expect(changedFields(v(), v({ vehicle: 'van9' }))).toEqual(['vehicle']);
    expect(changedFields(v(), v({ pax: 5 }))).toEqual(['pax']);
    expect(changedFields(v(), v({ bags: 4 }))).toEqual(['bags']);
  });

  it('names dates from the tool half', () => {
    const next = { ...v(), request: { ...v().request, tool: { legs: [{ date: '2026-09-02' }] } } };
    expect(changedFields(v(), next)).toEqual(['dates']);
  });

  // Old-shape legs are {from,to,distanceKm}; they must diff like their Ride equivalents.
  it('handles old-shape legs', () => {
    const oldShape = (km: number) => v({ legs: [{ from: 'A', to: 'B', distanceKm: km }] });
    expect(changedFields(oldShape(100), oldShape(120))).toEqual(['distance']);
    expect(changedFields(oldShape(100), oldShape(100))).toEqual([]);
  });

  it('never throws on a legacy or empty version', () => {
    expect(() => changedFields({ request: null, totalCents: 0 }, v())).not.toThrow();
    expect(() => changedFields(v(), { request: undefined, totalCents: 0 })).not.toThrow();
  });
});
