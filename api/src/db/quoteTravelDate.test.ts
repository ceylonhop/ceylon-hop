import { describe, it, expect } from 'vitest';
import { quoteTravelDate } from './quoteTravelDate';

describe('quoteTravelDate', () => {
  it('reads the date off a single dated leg', () => {
    expect(quoteTravelDate([{ from: 'Colombo', to: 'Galle', date: '2026-08-14' }])).toBe('2026-08-14');
  });

  it('returns the LAST travel day, not the first', () => {
    expect(quoteTravelDate([
      { from: 'Colombo', to: 'Kandy', date: '2026-08-10' },
      { from: 'Kandy', to: 'Ella', date: '2026-08-13' },
    ])).toBe('2026-08-13');
  });

  it('returns the latest date even when the legs are stored out of order', () => {
    expect(quoteTravelDate([
      { from: 'Kandy', to: 'Ella', date: '2026-08-13' },
      { from: 'Colombo', to: 'Kandy', date: '2026-08-10' },
    ])).toBe('2026-08-13');
  });

  it('ignores undated legs alongside dated ones', () => {
    expect(quoteTravelDate([
      { from: 'Colombo', to: 'Kandy', date: '2026-08-10' },
      { from: 'Kandy', to: 'Ella' },
    ])).toBe('2026-08-10');
  });

  it('treats an empty or whitespace date as absent', () => {
    // The tool sends date:'' for undated legs (ToolLegSchema preprocesses it to undefined).
    expect(quoteTravelDate([{ from: 'Colombo', to: 'Galle', date: '' }])).toBeNull();
    expect(quoteTravelDate([{ from: 'Colombo', to: 'Galle', date: '   ' }])).toBeNull();
  });

  it('ignores a malformed date rather than letting it win the max', () => {
    // request_json is untrusted and predates several schema revisions: a garbage string
    // must never sort above a real date and become the quote's travel date.
    expect(quoteTravelDate([
      { from: 'Colombo', to: 'Kandy', date: '2026-08-10' },
      { from: 'Kandy', to: 'Ella', date: 'next Tuesday' },
      { from: 'Ella', to: 'Galle', date: '2026-13-45' },
    ])).toBe('2026-08-10');
  });

  it('ignores a non-string date', () => {
    expect(quoteTravelDate([{ from: 'Colombo', to: 'Galle', date: 20260814 }])).toBeNull();
  });

  it('returns null when nothing is dated', () => {
    expect(quoteTravelDate([{ from: 'Colombo', to: 'Galle' }])).toBeNull();
  });

  it('returns null for anything that is not a usable legs array', () => {
    expect(quoteTravelDate(undefined)).toBeNull();
    expect(quoteTravelDate([])).toBeNull();
    expect(quoteTravelDate('not-an-array')).toBeNull();
    expect(quoteTravelDate([null, 'nope', 7])).toBeNull();
  });
});
