import { describe, it, expect } from 'vitest';
import { CATEGORIES, drives } from './legCategory';

describe('legCategory', () => {
  it('drives is true for every driving category', () => {
    expect(CATEGORIES.transfer.drives).toBe(true);
    expect(CATEGORIES.airport.drives).toBe(true);
    expect(CATEGORIES.train_support.drives).toBe(true);
  });

  it('drives is false for stay_day', () => {
    expect(CATEGORIES.stay_day.drives).toBe(false);
  });

  it('drives() predicate matches CATEGORIES for each known category', () => {
    expect(drives({ category: 'transfer' })).toBe(true);
    expect(drives({ category: 'airport' })).toBe(true);
    expect(drives({ category: 'train_support' })).toBe(true);
    expect(drives({ category: 'stay_day' })).toBe(false);
  });

  it('defaults to driving for an unknown category', () => {
    expect(drives({ category: 'some_future_category' })).toBe(true);
  });

  it('defaults to driving for an absent category', () => {
    expect(drives({})).toBe(true);
    expect(drives({ category: undefined })).toBe(true);
  });
});
