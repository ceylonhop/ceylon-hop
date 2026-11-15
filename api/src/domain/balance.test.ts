import { describe, expect, it } from 'vitest';
import { balanceDueCents, isBalanceOpen, paidCents, tripPayments } from './balance';

const ok = (amount: number, purpose: 'full' | 'deposit' | 'balance' | 'add_on' = 'full') => ({ status: 'succeeded' as const, amount, purpose });
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

describe('pay on the day', () => {
  // Cash owed to the team on the day: the ledger is the only source of what has been paid.
  const onTheDay = (status: string, total: number) => ({ status, total, amountDueNow: total, paymentArrangement: 'on_the_day' as const });

  it('a confirmed booking with no payment yet owes the whole total', () => {
    expect(balanceDueCents(onTheDay('confirmed', 20000), [])).toBe(20000);
  });
  it('a confirmed booking owes nothing once the cash equals the total', () => {
    expect(balanceDueCents(onTheDay('confirmed', 20000), [ok(20000)])).toBe(0);
  });
  it('a completed or in-progress trip still owes the total until the cash is recorded', () => {
    expect(balanceDueCents(onTheDay('completed', 20000), [])).toBe(20000);
    expect(balanceDueCents(onTheDay('in_progress', 20000), [])).toBe(20000);
  });
  it('a cancelled booking owes nothing', () => {
    expect(balanceDueCents(onTheDay('cancelled', 20000), [])).toBe(0);
  });
  it('a failed payment does not count as paid', () => {
    expect(balanceDueCents(onTheDay('confirmed', 20000), [{ status: 'failed', amount: 20000, purpose: 'full' }])).toBe(20000);
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

// Add-ons after booking (spec 2026-11-14 §6.1): an add-on is paid for on its own payment row
// (purpose 'add_on'). That money is real, but it is not the trip's, so no rule about what the trip
// has been paid or still owes may count it.
describe('add-on payments are not trip money', () => {
  const onTheDay = (status: string, total: number) => ({ status, total, amountDueNow: total, paymentArrangement: 'on_the_day' as const });

  it('tripPayments drops add_on rows and nothing else', () => {
    const rows = [ok(5000, 'deposit'), ok(1000, 'add_on'), pending(15000), ok(15000, 'balance'), ok(20000), { status: 'failed', amount: 1000, purpose: 'add_on' }];
    expect(tripPayments(rows)).toEqual([ok(5000, 'deposit'), pending(15000), ok(15000, 'balance'), ok(20000)]);
    expect(tripPayments([])).toEqual([]);
  });

  it('paidCents still sums every row it is given; the trip figure is asked for with tripPayments', () => {
    const rows = [ok(5000, 'deposit'), ok(1000, 'add_on')];
    expect(paidCents(rows)).toBe(6000);
    expect(paidCents(tripPayments(rows))).toBe(5000);
  });

  it('a deposit booking with a paid add-on still owes total minus the deposit', () => {
    for (const s of ['paid', 'confirmed', 'in_progress']) {
      expect(balanceDueCents(booking(s, 20000, 5000), [ok(5000, 'deposit'), ok(1000, 'add_on')])).toBe(15000);
    }
  });

  it('a secured booking whose only payment is an add-on falls back to the planned split, as with no payment', () => {
    expect(balanceDueCents(booking('paid', 20000, 5000), [ok(1000, 'add_on')])).toBe(15000);
  });

  it('a pay-on-the-day booking with only an add-on payment still owes the full total', () => {
    expect(balanceDueCents(onTheDay('confirmed', 20000), [ok(1000, 'add_on')])).toBe(20000);
    expect(balanceDueCents(onTheDay('completed', 20000), [ok(1000, 'add_on')])).toBe(20000);
  });

  it('isBalanceOpen is unchanged by an add-on row', () => {
    // The last 1000 of the trip is still owed: the add-on's 1000 did not pay it.
    expect(isBalanceOpen(booking('confirmed', 6000, 5000), [ok(5000, 'deposit'), ok(1000, 'add_on')])).toBe(true);
    expect(isBalanceOpen(booking('confirmed', 20000, 5000), [ok(5000, 'deposit'), ok(15000, 'balance'), ok(1000, 'add_on')])).toBe(false);
    // An add-on payment is not a deposit: on its own it opens no balance.
    expect(isBalanceOpen(booking('confirmed', 20000, 5000), [ok(1000, 'add_on')])).toBe(false);
  });
});
