import { describe, expect, it } from 'vitest';
import { balanceDueCents, isBalanceOpen, paidCents } from './balance';

const ok = (amount: number, purpose: 'full' | 'deposit' | 'balance' = 'full') => ({ status: 'succeeded' as const, amount, purpose });
const pending = (amount: number, purpose: 'full' | 'deposit' | 'balance' = 'balance') => ({ status: 'pending' as const, amount, purpose });
const booking = (status: string, total: number, amountDueNow: number | null = total) => ({ status, total, amountDueNow });

describe('paidCents', () => {
  it('sums succeeded payments only', () => {
    expect(paidCents([ok(5000, 'deposit'), pending(15000), ok(15000, 'balance')])).toBe(20000);
  });
});

describe('balanceDueCents', () => {
  it('a full-paid booking owes nothing', () => {
    expect(balanceDueCents(booking('paid', 20000), [ok(20000)])).toBe(0);
  });
  it('a deposit booking owes total minus what was paid, through confirmed and in_progress', () => {
    for (const s of ['paid', 'confirmed', 'in_progress']) {
      expect(balanceDueCents(booking(s, 20000, 5000), [ok(5000, 'deposit')])).toBe(15000);
    }
  });
  it('drops to zero once the balance lands', () => {
    expect(balanceDueCents(booking('confirmed', 20000, 5000), [ok(5000, 'deposit'), ok(15000, 'balance')])).toBe(0);
  });
  it("before any payment it is the planned split (today's meaning)", () => {
    expect(balanceDueCents(booking('payment_pending', 20000, 5000), [])).toBe(15000);
    expect(balanceDueCents(booking('draft', 20000), [])).toBe(0);
    expect(balanceDueCents({ status: 'payment_pending', total: 20000, amountDueNow: null }, [])).toBe(0);
  });
  it('a secured booking with no recorded payment falls back to the planned split, never the whole total', () => {
    expect(balanceDueCents(booking('paid', 20000), [])).toBe(0);
    expect(balanceDueCents(booking('paid', 20000, 5000), [])).toBe(15000);
  });
  it('closed bookings owe nothing', () => {
    for (const s of ['cancelled', 'refunded', 'no_show', 'completed']) {
      expect(balanceDueCents(booking(s, 20000, 5000), [ok(5000, 'deposit')])).toBe(0);
    }
  });
});

describe('isBalanceOpen', () => {
  it('only for a secured booking with a settled deposit and money left to pay', () => {
    expect(isBalanceOpen(booking('confirmed', 20000, 5000), [ok(5000, 'deposit')])).toBe(true);
    expect(isBalanceOpen(booking('confirmed', 20000, 5000), [ok(5000, 'deposit'), ok(15000, 'balance')])).toBe(false);
    expect(isBalanceOpen(booking('payment_pending', 20000, 5000), [])).toBe(false);
    expect(isBalanceOpen(booking('paid', 20000), [ok(20000)])).toBe(false);
    expect(isBalanceOpen(booking('cancelled', 20000, 5000), [ok(5000, 'deposit')])).toBe(false);
  });
});
