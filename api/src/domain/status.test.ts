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
});
