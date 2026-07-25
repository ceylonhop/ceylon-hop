import { describe, it, expect } from 'vitest';
import { quoteRouteText, requestLegs } from './quoteRouteText';

describe('quoteRouteText', () => {
  it('renders a point-to-point leg', () => {
    expect(quoteRouteText([{ from: 'Colombo', to: 'Galle' }])).toBe('Colombo · Galle');
  });

  it('collapses the handoff place between consecutive legs', () => {
    expect(quoteRouteText([
      { from: 'Colombo', to: 'Kandy' },
      { from: 'Kandy', to: 'Ella' },
    ])).toBe('Colombo · Kandy · Ella');
  });

  it('uses the full stop chain on a multi-stop leg', () => {
    expect(quoteRouteText([
      { from: 'Colombo', to: 'Ella', stops: ['Colombo', 'Kandy', 'Ella'] },
    ])).toBe('Colombo · Kandy · Ella');
  });

  it('keeps a genuine return to the same place', () => {
    expect(quoteRouteText([
      { from: 'Colombo', to: 'Kandy' },
      { from: 'Kandy', to: 'Colombo' },
    ])).toBe('Colombo · Kandy · Colombo');
  });

  it('renders a stay day as its single place', () => {
    expect(quoteRouteText([{ from: 'Kandy', to: 'Kandy', category: 'stay_day' }])).toBe('Kandy');
  });

  it('ignores blank and whitespace-only places', () => {
    expect(quoteRouteText([{ from: '   ', to: 'Galle' }])).toBe('Galle');
  });

  it('returns null when there is nothing usable', () => {
    expect(quoteRouteText(undefined)).toBeNull();
    expect(quoteRouteText([])).toBeNull();
    expect(quoteRouteText('not-an-array')).toBeNull();
    expect(quoteRouteText([null, 5])).toBeNull();
  });

  it('never throws on a malformed request', () => {
    expect(() => quoteRouteText([{ from: 5, to: {} }, { stops: 'nope' }])).not.toThrow();
    expect(quoteRouteText([{ from: 5, to: {} }, { stops: 'nope' }])).toBeNull();
  });
});

describe('requestLegs', () => {
  it('pulls legs out of the saved { tool, engine } envelope', () => {
    expect(requestLegs({ tool: { legs: [{ from: 'A', to: 'B' }] }, engine: {} }))
      .toEqual([{ from: 'A', to: 'B' }]);
  });

  it('falls back to top-level legs for a bare request', () => {
    expect(requestLegs({ legs: [{ from: 'A', to: 'B' }] })).toEqual([{ from: 'A', to: 'B' }]);
  });

  it('returns undefined for a non-object request', () => {
    expect(requestLegs(null)).toBeUndefined();
    expect(requestLegs('x')).toBeUndefined();
  });
});
