import { describe, it, expect } from 'vitest';
import { contentChanged } from './internalQuote.js';

/* Editing someone else's quote should hand it to you — but only if you actually CHANGED it
   (owner, 2026-08-01). Opening a quote to read it, or a save that transition() fires before a
   status change, must not quietly take it off the person who built it.

   "Changed" is decided server-side from the stored row, never from a client flag: a flag the
   builder forgets to send (or sends wrongly) would move ownership silently, which is exactly
   the failure this guard exists to prevent. */

const stored = {
  customerName: 'Maya Silva',
  customerContact: '+94770000000',
  totalCents: 22900,
  notes: null,
  internalNotes: null,
  requestedService: 'private',
  request: { tool: { vehicle: 'car', passengerCount: 2, legs: [{ from: 'Colombo', to: 'Kandy', distanceKm: 120 }] } },
};
const same = () => JSON.parse(JSON.stringify(stored));

describe('contentChanged — what counts as an edit', () => {
  it('an identical re-save is NOT an edit', () => {
    expect(contentChanged(stored, same())).toBe(false);
  });

  it('a changed leg is an edit', () => {
    const next = same();
    next.request.tool.legs[0].to = 'Ella';
    expect(contentChanged(stored, next)).toBe(true);
  });

  it('a changed price is an edit, even if the itinerary text looks the same', () => {
    const next = same();
    next.totalCents = 26600;
    expect(contentChanged(stored, next)).toBe(true);
  });

  it('customer details, notes and the recorded request all count', () => {
    for (const mutate of [
      (n: Record<string, unknown>) => { n.customerName = 'Maya R.'; },
      (n: Record<string, unknown>) => { n.customerContact = '+94770000001'; },
      (n: Record<string, unknown>) => { n.notes = 'called back'; },
      (n: Record<string, unknown>) => { n.internalNotes = 'watch the dates'; },
      (n: Record<string, unknown>) => { n.requestedService = 'both'; },
    ]) {
      const next = same();
      mutate(next);
      expect(contentChanged(stored, next)).toBe(true);
    }
  });

  it('is not fooled by key ORDER — a reserialised payload is not an edit', () => {
    const next = same();
    next.request = { tool: { legs: next.request.tool.legs, passengerCount: 2, vehicle: 'car' } };
    expect(contentChanged(stored, next)).toBe(false);
  });

  it('treats a missing stored row as an edit — nothing to compare means do not assume no-op', () => {
    expect(contentChanged(null, same())).toBe(true);
  });
});
