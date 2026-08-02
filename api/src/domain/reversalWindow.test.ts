import { describe, it, expect } from 'vitest';
import { tripStartAt, mayReverse, REVERSAL_WINDOW_HOURS } from './reversalWindow';
import type { Booking } from '../db/bookingRepo';

// Owner rule, 2026-08-02: an ops agent may cancel or refund up to 24 hours before the trip
// starts, and must give a reason. Inside that last day the driver is committed and the money
// is real, so only a founder may reverse. A founder is never time-limited.

const single = (date?: string, time?: string) =>
  ({ mode: 'single', input: { date, time } } as unknown as Booking);
const trip = (dates?: string[]) => ({ mode: 'trip', input: { dates } } as unknown as Booking);
const shared = (date: string, time: string) =>
  ({ mode: 'shared', input: { date, time } } as unknown as Booking);

// Sri Lanka is a fixed UTC+05:30, so these are exact instants.
const at = (iso: string) => new Date(iso);

describe('tripStartAt — when the trip actually begins, in Asia/Colombo', () => {
  it('reads date + time off a single transfer', () => {
    expect(tripStartAt(single('2026-09-16', '08:00'))?.toISOString()).toBe('2026-09-16T02:30:00.000Z');
  });

  it('defaults a dateless time-less single transfer to null, not to now', () => {
    expect(tripStartAt(single(undefined, undefined))).toBeNull();
  });

  it('treats a date with no time as the start of that day', () => {
    // 00:00 +05:30 — the earliest the trip could begin, which is the safe end for a cutoff.
    expect(tripStartAt(single('2026-09-16'))?.toISOString()).toBe('2026-09-15T18:30:00.000Z');
  });

  it('takes the EARLIEST date of a multi-day trip', () => {
    expect(tripStartAt(trip(['2026-09-20', '2026-09-16', '2026-09-18']))?.toISOString())
      .toBe('2026-09-15T18:30:00.000Z');
  });

  it('is null for a trip with no dates at all', () => {
    expect(tripStartAt(trip([]))).toBeNull();
    expect(tripStartAt(trip(undefined))).toBeNull();
  });

  it('reads a shared departure', () => {
    expect(tripStartAt(shared('2026-09-16', '13:00'))?.toISOString()).toBe('2026-09-16T07:30:00.000Z');
  });

  it('is null for a malformed date rather than an Invalid Date', () => {
    expect(tripStartAt(single('not-a-date', '08:00'))).toBeNull();
  });
});

describe('mayReverse', () => {
  const tripAt = single('2026-09-16', '08:00'); // 2026-09-16T02:30Z

  describe('founder — never time-limited', () => {
    it('may reverse well before the trip', () => {
      expect(mayReverse('founder', tripAt, at('2026-09-01T00:00:00Z')).ok).toBe(true);
    });
    it('may reverse inside the last 24 hours', () => {
      expect(mayReverse('founder', tripAt, at('2026-09-16T01:00:00Z')).ok).toBe(true);
    });
    it('may reverse after the trip has started', () => {
      expect(mayReverse('founder', tripAt, at('2026-09-20T00:00:00Z')).ok).toBe(true);
    });
    it('may reverse a booking whose date nobody ever set', () => {
      expect(mayReverse('founder', single(), at('2026-09-01T00:00:00Z')).ok).toBe(true);
    });
  });

  describe('ops — allowed only while more than 24 hours remain', () => {
    it('may reverse with a clear month to go', () => {
      expect(mayReverse('ops', tripAt, at('2026-08-16T00:00:00Z')).ok).toBe(true);
    });

    it('may reverse just outside the cutoff', () => {
      // cutoff = 2026-09-15T02:30Z; a minute earlier is still allowed.
      expect(mayReverse('ops', tripAt, at('2026-09-15T02:29:00Z')).ok).toBe(true);
    });

    it('may NOT reverse exactly at the cutoff — the boundary belongs to the founder', () => {
      const out = mayReverse('ops', tripAt, at('2026-09-15T02:30:00Z'));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('within_24h_founder_only');
    });

    it('may NOT reverse inside the last day', () => {
      expect(mayReverse('ops', tripAt, at('2026-09-16T01:00:00Z')).ok).toBe(false);
    });

    it('may NOT reverse after the trip has started', () => {
      expect(mayReverse('ops', tripAt, at('2026-09-20T00:00:00Z')).ok).toBe(false);
    });

    // Fail closed. An unknown start cannot be shown to be outside the window, and the whole
    // point of the rule is that the last day is protected.
    it('may NOT reverse a booking with no known start date', () => {
      const out = mayReverse('ops', single(), at('2026-09-01T00:00:00Z'));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('trip_start_unknown');
    });
  });

  describe('finance — unchanged by this rule', () => {
    it('may not reverse, however far out the trip is', () => {
      expect(mayReverse('finance', tripAt, at('2026-08-01T00:00:00Z')).ok).toBe(false);
    });
  });

  it('exposes the window so the number is testable rather than buried', () => {
    expect(REVERSAL_WINDOW_HOURS).toBe(24);
  });
});
