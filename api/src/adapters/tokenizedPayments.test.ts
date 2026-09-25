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
// The Fake validates a charge the way PayHereTokenizedPaymentAdapter does (an
// empty ref, a missing orderId or a non-positive amount is a 'failed'
// invalid_charge_request that never reaches the gateway) and replays a repeat
// orderId instead of charging it twice (hardening 2026-09-25). Tests still
// marked "documents:" pin behaviour the Fake cannot know better about (it has
// no token registry, so an unknown-but-non-empty ref still succeeds).
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
  // documents: the Fake keeps no token registry, so a non-empty ref it never issued still
  // charges. The real gateway would decline; the Fake cannot know.
  it('documents: charging an unknown (non-empty) ref still succeeds', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const res = await a.charge({ ref: 'pa_never_issued', amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-x' });
    expect(res.status).toBe('succeeded');
    expect(a.charges).toHaveLength(1);
  });

  // Mirrors PayHereTokenizedPaymentAdapter.charge(): these requests are refused before they
  // could reach a gateway, so no money moved — a POSITIVE 'failed', never 'succeeded'.
  it('fails an EMPTY ref as invalid_charge_request — the missing-preapproval case is caught', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const res = await a.charge({ ref: '', amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-x' });
    expect(res).toEqual({ status: 'failed', failureReason: 'invalid_charge_request' });
  });

  it('fails a charge with no orderId as invalid_charge_request', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const res = await a.charge({ ref, amountCents: 4500, currency: 'USD', orderId: '' });
    expect(res).toEqual({ status: 'failed', failureReason: 'invalid_charge_request' });
  });

  it('fails a zero-amount charge as invalid_charge_request', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const res = await a.charge({ ref, amountCents: 0, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res).toEqual({ status: 'failed', failureReason: 'invalid_charge_request' });
  });

  it('fails a NEGATIVE amount as invalid_charge_request', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const res = await a.charge({ ref, amountCents: -4500, currency: 'USD', orderId: 'RB-AAA-sub-1' });
    expect(res).toEqual({ status: 'failed', failureReason: 'invalid_charge_request' });
  });

  // Adapter-level idempotency: re-running the sweep against a member whose status write failed
  // after a successful charge would send the same orderId again. The Fake replays the first
  // outcome instead of charging twice. (Whether PayHere's own Charging API dedupes on order_id
  // is unknown — see payhereTokenized.ts; production relies on rideBoardCutoff.ts bookkeeping.)
  it('replays the first result when the same orderId is charged twice (no double charge)', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    const args = { ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' };

    const first = await a.charge({ ...args });
    const second = await a.charge({ ...args });

    expect(first.status).toBe('succeeded');
    expect(second).toEqual(first); // same providerTxnId: one charge, replayed
    expect(a.charges).toHaveLength(2); // both CALLS are still recorded, so a sweep bug stays visible
  });

  it('replays an indeterminate first outcome too — the card may already have been debited', async () => {
    const a = new FakeTokenizedPaymentAdapter();
    const { ref } = await a.preapprove({ customerRef: 'sub-1' });
    a.markRefWillBeUnknown(ref);
    const args = { ref, amountCents: 4500, currency: 'USD', orderId: 'RB-AAA-sub-1' };
    const first = await a.charge({ ...args });
    const second = await a.charge({ ...args });
    expect(first.status).toBe('unknown');
    expect(second).toEqual(first);
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
