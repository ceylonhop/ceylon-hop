import { describe, it, expect } from 'vitest';
import { FakeTokenizedPaymentAdapter, type TokenizedPaymentAdapter } from './tokenizedPayments';

// ============================================================================
// Why this file exists: FakeTokenizedPaymentAdapter is the money seam the whole
// Ride Board runs on today — every join takes a $0 preapproval through it, and
// the cutoff sweep (services/rideBoardCutoff.ts) charges every held card
// through it. Until the real PayHere Preapproval/Charging adapter lands, this
// Fake IS the payment behaviour those tests assert against, so its contract
// (unique refs, recorded calls, a failure seam, what a charge result looks
// like) has to be pinned down or the ride-board tests are asserting against
// sand.
//
// Several tests below deliberately pin behaviour that is NOT safe for real
// money (empty refs succeed, repeat orderIds double-charge, negative amounts
// are accepted). They are marked "documents:" — they exist so that whoever
// swaps in the real gateway sees exactly which guarantees the Fake never made.
// ============================================================================

describe('FakeTokenizedPaymentAdapter — interface shape', () => {
  it('satisfies TokenizedPaymentAdapter and identifies itself as the fake provider', async () => {
    const a: TokenizedPaymentAdapter = new FakeTokenizedPaymentAdapter();
    expect(a.provider).toBe('fake-tokenized');
    expect(typeof a.preapprove).toBe('function');
    expect(typeof a.charge).toBe('function');
  });

  it('preapprove resolves to an object whose only contract is a non-empty string ref', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const res = await a.preapprove({ customerRef: 'sub-1' });
    expect(Object.keys(res)).toEqual(['status', 'ref']);
    expect(res.status).toBe('approved');
    expect(typeof res.ref).toBe('string');
    expect(res.ref.length).toBeGreaterThan(0);
  });

  it('charge resolves to a succeeded status carrying a provider transaction id', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const res = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res.status).toBe('succeeded');
    expect(res.providerTxnId).toBeTruthy();
    expect(res.failureReason).toBeUndefined();
  });
});

describe('FakeTokenizedPaymentAdapter — preapproval', () => {
  it('records every preapproval call, in order, with the args it was given', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    await a.preapprove({ customerRef: 'sub-1', customer: { firstName: 'Ama', email: 'a@x.com', country: 'LK' } });
    await a.preapprove({ customerRef: 'sub-2' });

    expect(a.preapprovals).toHaveLength(2);
    expect(a.preapprovals[0]?.customerRef).toBe('sub-1');
    expect(a.preapprovals[0]?.customer).toEqual({ firstName: 'Ama', email: 'a@x.com', country: 'LK' });
    expect(a.preapprovals[1]?.customerRef).toBe('sub-2');
    expect(a.preapprovals[1]?.customer).toBeUndefined();
  });

  it('issues a distinct ref for every preapproval, even for the same customer', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const refs = [
      (await a.preapprove({ customerRef: 'sub-1' })).ref,
      (await a.preapprove({ customerRef: 'sub-1' })).ref,
      (await a.preapprove({ customerRef: 'sub-2' })).ref,
    ];
    expect(new Set(refs).size).toBe(3);
  });

  it('starts its ref sequence fresh per instance — a new adapter is the reset seam', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const b = new FakeTokenizedPaymentAdapter();
    const first = await a.preapprove({ customerRef: 'sub-1' });
    const other = await b.preapprove({ customerRef: 'sub-9' });
    expect(other.ref).toBe(first.ref); // refs are only unique WITHIN one adapter
    expect(b.preapprovals).toHaveLength(1);
    expect(b.charges).toHaveLength(0);
  });
});

describe('FakeTokenizedPaymentAdapter — charging', () => {
  it('records every charge attempt, including ones that fail', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const ok = await a.preapprove({ customerRef: 'sub-1' });
    const bad = await a.preapprove({ customerRef: 'sub-2' });
    a.markRefWillFail(bad.ref);

    await a.charge({ ref: ok.ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    await a.charge({ ref: bad.ref, amountCents: 9000, currency: 'USD', orderId: 'RB-AAA-sub-2' });

    expect(a.charges).toHaveLength(2);
    expect(a.charges[0]).toEqual({ ref: ok.ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(a.charges[1]?.amountCents).toBe(9000);
  });

  it('ties the provider transaction id to the orderId so a charge is traceable', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const res = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res.providerTxnId).toContain('RB-AAA-sub-1');
  });

  it('fails a ref marked to fail, with a reason and no transaction id', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    a.markRefWillFail(ref);

    const res = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res.status).toBe('failed');
    expect(res.failureReason).toBe('card_declined');
    expect(res.providerTxnId).toBeUndefined();
  });

  it('fails only the marked ref — other travellers on the same ride still charge', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const one = await a.preapprove({ customerRef: 'sub-1' });
    const two = await a.preapprove({ customerRef: 'sub-2' });
    a.markRefWillFail(two.ref);

    const r1 = await a.charge({ ref: one.ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    const r2 = await a.charge({ ref: two.ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-2' });
    expect(r1.status).toBe('succeeded');
    expect(r2.status).toBe('failed');
  });

  it('keeps a marked ref failing on every subsequent attempt (the mark is sticky, not one-shot)', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    a.markRefWillFail(ref);

    const first = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    const second = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
  });

  it('can mark a ref to fail before it has ever been preapproved', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    a.markRefWillFail('pa_1');
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    expect(ref).toBe('pa_1');
    const res = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res.status).toBe('failed');
  });
});

describe('FakeTokenizedPaymentAdapter — money edge cases', () => {
  // documents: the Fake never validates the token. rideBoardCutoff.ts charges
  // `ref: m.preapprovalRef ?? ''` — a member row with a NULL preapproval ref
  // therefore charges an empty token and is reported as paid. Under the Fake
  // that is silently "succeeded"; a real gateway would decline. Pinned so the
  // real adapter is not written to match this.
  it('documents: charging an unknown ref still succeeds (the fake does not validate tokens)', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const res = await a.charge({ ref: 'pa_never_issued', amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-x' });
    expect(res.status).toBe('succeeded');
    expect(a.charges).toHaveLength(1);
  });

  it('documents: charging an EMPTY ref succeeds — the missing-preapproval case is not caught', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const res = await a.charge({ ref: '', amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-x' });
    expect(res.status).toBe('succeeded');
  });

  it('documents: a zero-amount charge is accepted and reported as succeeded', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const res = await a.charge({ ref, amountCents: 0, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res.status).toBe('succeeded');
    expect(a.charges[0]?.amountCents).toBe(0);
  });

  it('documents: a NEGATIVE amount is accepted and reported as succeeded', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const res = await a.charge({ ref, amountCents: -4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res.status).toBe('succeeded');
    expect(a.charges[0]?.amountCents).toBe(-4500);
  });

  // documents: there is NO idempotency key. Re-running the cutoff sweep against
  // a member whose status write failed after a successful charge would charge
  // the same orderId a second time, and the Fake would happily succeed with a
  // DIFFERENT providerTxnId — i.e. a silent double charge. rideBoardCutoff.ts
  // relies on list/member status to avoid this; the adapter itself offers no
  // protection.
  it('documents: charging the same orderId twice double-charges (no idempotency)', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const args = { ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' };

    const first = await a.charge({ ...args });
    const second = await a.charge({ ...args });

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(second.providerTxnId).not.toBe(first.providerTxnId);
    expect(a.charges).toHaveLength(2); // two real charge attempts, not a replayed one
  });

  it('does not reuse a provider transaction id across different orders', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const one = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    const two = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-2' });
    expect(one.providerTxnId).not.toBe(two.providerTxnId);
  });

  it('passes the currency straight through without normalising it', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    await a.charge({ ref, amountCents: 4500, currency: 'lkr', orderId: 'RB-AAA-sub-1' });
    expect(a.charges[0]?.currency).toBe('lkr');
  });

  it('refuses to construct in production unless a non-money environment explicitly opts in', () => {
    const prev = process.env.NODE_ENV;
    const prevAllow = process.env.ALLOW_FAKE_PAYMENTS;
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_FAKE_PAYMENTS;
    try {
      expect(() => new FakeTokenizedPaymentAdapter()).toThrow(/must never be used in production/);
      process.env.ALLOW_FAKE_PAYMENTS = '1';
      expect(() => new FakeTokenizedPaymentAdapter()).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
      if (prevAllow === undefined) delete process.env.ALLOW_FAKE_PAYMENTS;
      else process.env.ALLOW_FAKE_PAYMENTS = prevAllow;
    }
  });
});
