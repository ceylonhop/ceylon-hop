import { describe, it, expect } from 'vitest';
import { rateCardFor, rateLockUntil, RATE_LOCK_WINDOW_MS } from './rateLock';
import { RATE_CARD, type RateCard } from './rateCard';

// A locked snapshot that differs from the current card (own version + a cheaper car per-km).
const snapshot: RateCard = { ...RATE_CARD, version: 'locked-v1', perKmCents: { ...RATE_CARD.perKmCents, car: 20 } };
const now = new Date('2026-07-11T00:00:00Z');

describe('rateCardFor (rate-lock decision)', () => {
  it('no lock yet → current card + relock (stamp at first generation)', () => {
    const r = rateCardFor({ rateCardJson: null, rateLockedUntil: null }, now);
    expect(r.rateCard.version).toBe(RATE_CARD.version);
    expect(r.relock).toBe(true);
  });

  it('locked and still valid → the stored snapshot, no relock', () => {
    const r = rateCardFor({ rateCardJson: snapshot, rateLockedUntil: new Date(now.getTime() + 1000) }, now);
    expect(r.rateCard.version).toBe('locked-v1');
    expect(r.rateCard.perKmCents.car).toBe(20);
    expect(r.relock).toBe(false);
  });

  it('locked with NO expiry (ops freeze on approval) → the stored snapshot, no relock', () => {
    const r = rateCardFor({ rateCardJson: snapshot, rateLockedUntil: null }, now);
    expect(r.rateCard.version).toBe('locked-v1');
    expect(r.relock).toBe(false);
  });

  it('locked but expired → current card + relock (after 7 days, use the new card)', () => {
    const r = rateCardFor({ rateCardJson: snapshot, rateLockedUntil: new Date(now.getTime() - 1000) }, now);
    expect(r.rateCard.version).toBe(RATE_CARD.version);
    expect(r.relock).toBe(true);
  });

  it('expired but the current card is unchanged → same version, price does not move', () => {
    // "after 7 days AND the rate card changed → new card"; if it did NOT change, re-locking to the
    // current card is a no-op for the price (same version).
    const current: RateCard = { ...RATE_CARD, version: 'same' };
    const locked: RateCard = { ...RATE_CARD, version: 'same', perKmCents: { ...RATE_CARD.perKmCents, car: 20 } };
    const r = rateCardFor({ rateCardJson: locked, rateLockedUntil: new Date(now.getTime() - 1000) }, now, current);
    expect(r.rateCard.version).toBe('same');
    expect(r.relock).toBe(true);
  });
});

describe('rateLockUntil', () => {
  it('is now + 7 days', () => {
    expect(rateLockUntil(now).getTime()).toBe(now.getTime() + RATE_LOCK_WINDOW_MS);
    expect(RATE_LOCK_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
