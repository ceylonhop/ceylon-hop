import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, IllegalTransitionError } from './status';

describe('booking lifecycle transitions', () => {
  it('allows draft -> payment_pending', () => {
    expect(canTransition('draft', 'payment_pending')).toBe(true);
  });

  it('rejects draft -> completed (no skipping)', () => {
    expect(canTransition('draft', 'completed')).toBe(false);
  });

  it('treats completed as terminal', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false);
  });

  it('assertTransition throws IllegalTransitionError on an illegal move', () => {
    expect(() => assertTransition('draft', 'completed')).toThrow(IllegalTransitionError);
  });

  it('assertTransition is silent on a legal move', () => {
    expect(() => assertTransition('paid', 'confirmed')).not.toThrow();
  });

  // Pay on the day (0077): the trip goes ahead before any money. Only the arrangement opens the edge.
  it('a pay-on-the-day booking may be confirmed without payment', () => {
    expect(canTransition('payment_pending', 'confirmed', { paymentArrangement: 'on_the_day' })).toBe(true);
    expect(() => assertTransition('payment_pending', 'confirmed', { paymentArrangement: 'on_the_day' })).not.toThrow();
  });

  it('an ordinary unpaid booking may NOT be confirmed', () => {
    expect(canTransition('payment_pending', 'confirmed')).toBe(false);
    expect(canTransition('payment_pending', 'confirmed', { paymentArrangement: null })).toBe(false);
    expect(() => assertTransition('payment_pending', 'confirmed')).toThrow(IllegalTransitionError);
  });

  it('the arrangement opens no other edge', () => {
    for (const to of ['in_progress', 'completed', 'no_show', 'refunded'] as const) {
      expect(canTransition('payment_pending', to, { paymentArrangement: 'on_the_day' })).toBe(false);
    }
    expect(canTransition('draft', 'confirmed', { paymentArrangement: 'on_the_day' })).toBe(false);
    expect(canTransition('awaiting_details', 'confirmed', { paymentArrangement: 'on_the_day' })).toBe(false);
  });
});
