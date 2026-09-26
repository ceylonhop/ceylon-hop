import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// Payment lookup (spec 2026-09-26): GET /admin/ops/cases/:ref returns FACTS — verdict kinds, row
// kinds, gap codes. The words live in ops-ui.html as pure functions, extracted here by source
// markers and eval'd with the page's own helpers (same trick as ops-day-groups.test.js), so this
// suite exercises the REAL page code and the page can never say something this file doesn't.

// A top-level `function name(…){ … }` whose closing brace sits in column 0.
function fnSrc(name) {
  const m = html.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error(`function ${name} not found in ops-ui.html`);
  return m[0];
}
// A one-line top-level `const name=…;`.
function constSrc(name) {
  const m = html.match(new RegExp('\\nconst ' + name + '=.*'));
  if (!m) throw new Error(`const ${name} not found in ops-ui.html`);
  return m[0];
}

// eslint-disable-next-line no-new-func
const W = new Function(`
  ${constSrc('_pad')}
  ${constSrc('money')}
  ${constSrc('PAY_METHODS')}
  ${constSrc('payMethodLabel')}
  ${constSrc('PA_TONE')}
  ${fnSrc('paLabel')}
  ${fnSrc('lookupTime')}
  ${fnSrc('lookupVerdictText')}
  ${fnSrc('lookupRowLabel')}
  ${fnSrc('lookupRowDetail')}
  ${fnSrc('lookupRowTone')}
  ${fnSrc('lookupGapText')}
  ${fnSrc('lookupUnavailableText')}
  return { paLabel, lookupTime, lookupVerdictText, lookupRowLabel, lookupRowDetail, lookupRowTone, lookupGapText, lookupUnavailableText };
`)();

// Times are built from LOCAL components, so the expected "DD Mon HH:MM:SS" string is the same in
// every timezone the suite runs in (the page shows local time, with UTC in the row's title).
const at = (mo, d, h, mi, s) => new Date(2026, mo - 1, d, h, mi, s).toISOString();

const verdict = (over) => ({
  kind: 'never_started', at: null, amount: null, currency: 'USD', checkouts: 0, declineNotices: 0,
  countsComplete: true, payhere: null, manual: null, paidOn: null, captures: null, refund: null,
  chargebackAt: null, cancellation: null, warnings: [], ...over,
});

describe('lookupTime', () => {
  it('shows local time to the second as DD Mon HH:MM:SS', () => {
    expect(W.lookupTime(at(9, 24, 7, 5, 9))).toBe('24 Sep 07:05:09');
    expect(W.lookupTime(at(1, 3, 23, 59, 0))).toBe('03 Jan 23:59:00');
  });
  it('says — for a missing or unreadable time', () => {
    expect(W.lookupTime(null)).toBe('—');
    expect(W.lookupTime('not a date')).toBe('—');
  });
});

describe('lookupVerdictText — one title per situation, with the facts behind it', () => {
  it('paid: amount, when, card, PayHere id and the counts before it', () => {
    const v = verdict({
      kind: 'paid', at: at(9, 24, 19, 20, 1), amount: 12000, checkouts: 2, declineNotices: 1,
      payhere: { code: '2', message: 'Successfully received', method: 'VISA', paymentId: '320025071' },
    });
    const t = W.lookupVerdictText(v);
    expect(t.title).toBe('Paid by card');
    expect(t.detail).toBe('$120 · 24 Sep 19:20:01 · VISA · PayHere 320025071 · 2 checkouts, 1 decline notice before it');
    expect(t.warnings).toEqual([]);
    expect(t.refund).toBeNull();
    expect(t.cancellation).toBeNull();
  });

  it('paid: counts from before the checkout log say so', () => {
    const t = W.lookupVerdictText(verdict({
      kind: 'paid', at: at(9, 20, 10, 0, 0), amount: 5000, checkouts: 1, declineNotices: 0, countsComplete: false,
      payhere: { code: '2', message: null, method: 'MASTER', paymentId: '42' },
    }));
    expect(t.detail).toBe('$50 · 20 Sep 10:00:00 · MASTER · PayHere 42 · 1 checkout, 0 decline notices before it (since 24 Sep)');
  });

  it('paid_by_hand: method in words, who recorded it and their reference', () => {
    const t = W.lookupVerdictText(verdict({
      kind: 'paid_by_hand', at: at(9, 25, 9, 30, 0), amount: 5000,
      manual: { method: 'bank_transfer', settledBy: 'fin@x.com', reference: 'TRX-9' },
    }));
    expect(t.title).toBe('Paid by hand');
    expect(t.detail).toBe('$50 · 25 Sep 09:30:00 · Bank transfer · recorded by fin@x.com · ref TRX-9');
  });

  it('paid_by_hand: a row older than 0043 has no recorder and no reference', () => {
    const cash = W.lookupVerdictText(verdict({ kind: 'paid_by_hand', amount: 5000, manual: { method: 'cash', settledBy: null, reference: null } }));
    expect(cash.detail).toBe('$50 · Cash · recorded by not recorded · ref none');
    const other = W.lookupVerdictText(verdict({ kind: 'paid_by_hand', amount: 5000, manual: { method: 'manual_other', settledBy: 'f@x.com', reference: 'x' } }));
    expect(other.detail).toContain('· Other ·');
  });

  it('declined: PayHere’s message in quotes with its code, plus the counts', () => {
    const t = W.lookupVerdictText(verdict({
      kind: 'declined', at: at(9, 25, 8, 3, 0), checkouts: 2, declineNotices: 3,
      payhere: { code: '-2', message: 'Insufficient funds', method: 'VISA', paymentId: '0' },
    }));
    expect(t.title).toBe('Declined — still unpaid');
    expect(t.detail).toBe('“Insufficient funds” (code -2) · 25 Sep 08:03:00 · 2 checkouts, 3 decline notices');
  });

  it('declined: -1 is the customer cancelling on PayHere’s page; a -2 with no message says so', () => {
    const cancelled = W.lookupVerdictText(verdict({ kind: 'declined', checkouts: 1, payhere: { code: '-1', message: null, method: null, paymentId: null } }));
    expect(cancelled.detail).toBe('Cancelled on PayHere’s page · 1 checkout, 0 decline notices');
    const bare = W.lookupVerdictText(verdict({ kind: 'declined', checkouts: 1, declineNotices: 1, countsComplete: false, payhere: { code: '-2', message: null, method: null, paymentId: null } }));
    expect(bare.detail).toBe('no message (code -2) · 1 checkout, 1 decline notice (since 24 Sep)');
  });

  it('reached_no_answer: when, and that 3-D Secure and closing the page look the same', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'reached_no_answer', at: at(9, 25, 8, 2, 0) }));
    expect(t.title).toBe('Reached PayHere, no answer');
    expect(t.detail).toBe('Reached PayHere 25 Sep 08:02:00. A 3-D Secure failure and closing the page look the same here — PayHere sends nothing for either.');
  });

  it('checkout_no_trace: when the checkout started, and that nothing followed', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'checkout_no_trace', at: at(9, 25, 8, 1, 0) }));
    expect(t.title).toBe('Started checkout, nothing after');
    expect(t.detail).toBe('Checkout started 25 Sep 08:01:00; nothing recorded after it.');
  });

  it('never_started', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'never_started' }));
    expect(t.title).toBe('Never started checkout');
    expect(t.detail).toBe('The booking was created but checkout never started.');
  });

  it('paid_elsewhere names the paying booking', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'paid_elsewhere', paidOn: 'CH-PAID1' }));
    expect(t.title).toBe('Paid on another booking');
    expect(t.detail).toBe('Closed automatically — paid on CH-PAID1');
    expect(t.cancellation).toBeNull();
  });

  it('paid_twice lists both captures', () => {
    const two = W.lookupVerdictText(verdict({ kind: 'paid_twice', captures: [
      { via: 'payhere', id: '111', method: 'VISA' }, { via: 'payhere', id: '222', method: 'MASTER' },
    ] }));
    expect(two.title).toBe('Paid twice');
    expect(two.detail).toBe('PayHere 111 and PayHere 222');
    const mixed = W.lookupVerdictText(verdict({ kind: 'paid_twice', captures: [
      { via: 'payhere', id: '111', method: 'VISA' }, { via: 'manual', id: null, method: 'cash' },
    ] }));
    expect(mixed.detail).toBe('PayHere 111 and Cash by hand');
  });

  it('money_back: a chargeback says the booking may still read Paid', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'money_back', chargebackAt: at(9, 26, 10, 11, 12) }));
    expect(t.title).toBe('Money went back');
    expect(t.detail).toBe('Charged back on 26 Sep 10:11:12 — the booking may still say Paid.');
  });

  it('money_back: a refund reads as its state and how much of the capture went back — once', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'money_back', refund: { state: 'confirmed', refundedCents: 12000, capturedCents: 12000 } }));
    expect(t.detail).toBe('Refund confirmed: $120 of $120');
    expect(t.refund).toBeNull(); // already the detail — never said twice
  });

  it('money_back with both a chargeback and a refund keeps both facts', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'money_back', chargebackAt: at(9, 26, 10, 11, 12), refund: { state: 'processing', refundedCents: 0, capturedCents: 12000 } }));
    expect(t.detail).toBe('Charged back on 26 Sep 10:11:12 — the booking may still say Paid.');
    expect(t.refund).toBe('Refund processing: $0 of $120');
  });

  it('adds the refund line to any other situation that has refunds', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'paid_twice', captures: [{ via: 'payhere', id: '1', method: null }, { via: 'payhere', id: '2', method: null }],
      refund: { state: 'requested', refundedCents: 0, capturedCents: 24000 } }));
    expect(t.refund).toBe('Refund requested: $0 of $240');
    const failed = W.lookupVerdictText(verdict({ kind: 'paid', amount: 100, refund: { state: 'failed', refundedCents: 0, capturedCents: 100 } }));
    expect(failed.refund).toBe('Refund failed: $0 of $1');
  });

  it('falls back to the booking currency when the verdict carries none', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'money_back', currency: null, refund: { state: 'confirmed', refundedCents: 5000, capturedCents: 5000 } }), 'USD');
    expect(t.detail).toBe('Refund confirmed: $50 of $50');
  });

  it('adds the cancellation: who and why, or that neither was recorded', () => {
    expect(W.lookupVerdictText(verdict({ cancellation: { by: 'f@x.com', reason: 'customer asked' } })).cancellation)
      .toBe('Cancelled by f@x.com: customer asked');
    expect(W.lookupVerdictText(verdict({ cancellation: { by: 'f@x.com', reason: null } })).cancellation).toBe('Cancelled by f@x.com');
    expect(W.lookupVerdictText(verdict({ cancellation: { by: null, reason: 'hold expired' } })).cancellation).toBe('Cancelled: hold expired');
    expect(W.lookupVerdictText(verdict({ cancellation: { by: null, reason: null } })).cancellation).toBe('Cancelled — who and why not recorded');
  });

  it('turns each warning code into a sentence, in order', () => {
    const t = W.lookupVerdictText(verdict({ kind: 'paid', amount: 100, warnings: ['money_on_unpaid_booking', 'money_after_cancel', 'paid_status_without_payment'] }));
    expect(t.warnings).toEqual([
      'Money received, but the booking still says unpaid — check it.',
      'Money arrived after the booking was cancelled — a refund may be owed.',
      'The booking says paid, but no payment is recorded.',
    ]);
  });
});

describe('lookupRowLabel — every row kind', () => {
  it('booking rows', () => {
    expect(W.lookupRowLabel({ kind: 'created' })).toBe('Booking created');
    expect(W.lookupRowLabel({ kind: 'cancelled', by: 'system:duplicate-close', reason: 'duplicate — paid on CH-PAID1', paidOn: 'CH-PAID1' }))
      .toBe('Closed automatically — paid on CH-PAID1');
    expect(W.lookupRowLabel({ kind: 'cancelled', by: 'f@x.com', reason: 'asked', paidOn: null })).toBe('Cancelled by f@x.com');
    expect(W.lookupRowLabel({ kind: 'cancelled', by: null, reason: null, paidOn: null })).toBe('Cancelled');
  });

  it('checkout-log rows read exactly as the drawer’s paLabel', () => {
    const log = { kind: 'log', action: 'gateway', outcome: 'error', reason: 'Card declined', attempt: null };
    expect(W.lookupRowLabel(log)).toBe(W.paLabel(log));
    expect(W.lookupRowLabel({ kind: 'log', action: 'checkout', outcome: 'succeeded', reason: null, attempt: 2 })).toBe('Checkout started (attempt 2)');
  });

  it('payment rows', () => {
    expect(W.lookupRowLabel({ kind: 'payment_created', orderId: 'CH-0001', amount: 10000, currency: 'USD' }))
      .toBe('Checkout set up — order CH-0001, $100');
    const settled = (method, settlementSource) => ({ kind: 'payment_settled', orderId: 'CH-0001-MANUAL', amount: 10000, currency: 'USD', method, settlementSource, settledBy: null, reference: null });
    expect(W.lookupRowLabel(settled('cash', 'manual'))).toBe('Marked paid by hand — Cash');
    expect(W.lookupRowLabel(settled('bank_transfer', 'manual'))).toBe('Marked paid by hand — Bank transfer');
    expect(W.lookupRowLabel(settled('manual_other', 'manual'))).toBe('Marked paid by hand — Other');
    expect(W.lookupRowLabel(settled('payhere', 'legacy_backfill'))).toBe('Recorded as paid (backfill)');
  });

  it('PayHere notices, by status code and note', () => {
    const n = (code, extra) => ({ kind: 'notice', code, message: null, method: null, paymentId: '1', amount: 100, currency: 'USD', note: null, repeats: null, ...extra });
    expect(W.lookupRowLabel(n('2'))).toBe('PayHere: paid');
    expect(W.lookupRowLabel(n('2', { note: 'paid_again' }))).toBe('PayHere: paid again — a second payment on this order');
    expect(W.lookupRowLabel(n('-2'))).toBe('PayHere: declined');
    expect(W.lookupRowLabel(n('-1'))).toBe('PayHere: cancelled on PayHere’s page');
    expect(W.lookupRowLabel(n('0'))).toBe('PayHere: pending');
    expect(W.lookupRowLabel(n('-3'))).toBe('PayHere: charged back');
    expect(W.lookupRowLabel(n('-2', { note: 'earlier_attempt' }))).toBe('PayHere: declined (earlier attempt)');
    expect(W.lookupRowLabel(n('-2', { repeats: 3 }))).toBe('PayHere: declined — PayHere sent 3 decline notices; repeats share this row');
    expect(W.lookupRowLabel(n('-2', { repeats: 1 }))).toBe('PayHere: declined');
    expect(W.lookupRowLabel(n('9'))).toBe('PayHere: code 9');
  });

  it('emails, by kind', () => {
    const e = (emailKind) => W.lookupRowLabel({ kind: 'email', emailKind, deliveryTracked: true });
    expect(e('confirmation')).toBe('Email: booking confirmation');
    expect(e('payment_failed')).toBe('Email: payment didn’t go through');
    expect(e('payment_recovery')).toBe('Email: payment reminder');
    expect(e('deposit_received')).toBe('Email: deposit received');
    expect(e('trip_reminder')).toBe('Email: trip reminder');
    expect(e('review_request')).toBe('Email: review request');
    expect(e('no_show_notice')).toBe('Email: no-show notice');
    expect(e('something_new')).toBe('Email: something_new');
  });

  it('refund steps', () => {
    const r = (step) => W.lookupRowLabel({ kind: 'refund', step, amount: 12000, currency: 'USD', by: null, ref: null, message: null, reason: null });
    expect(r('requested')).toBe('Refund requested — $120');
    expect(r('sent')).toBe('Refund sent to PayHere');
    expect(r('confirmed')).toBe('Refund confirmed — $120');
    expect(r('failed')).toBe('PayHere refund failed');
    expect(r('cancelled')).toBe('Refund request cancelled');
  });
});

describe('lookupRowDetail — the small line under each row', () => {
  it('log rows: reason, HTTP status, the raw user agent on client and return rows, and untrusted order matches', () => {
    expect(W.lookupRowDetail({ kind: 'log', action: 'webhook', outcome: 'refused', reason: 'bad_signature', httpStatus: 400, attempt: null, ua: null, client: false, orderMatchOnly: true }))
      .toBe('HTTP 400 · claimed to be for this order'); // the reason is already in paLabel's words
    expect(W.lookupRowDetail({ kind: 'log', action: 'return', outcome: 'failed', reason: 'cancel_url', httpStatus: null, attempt: null, ua: 'Mozilla/5.0 (iPhone)', client: false, orderMatchOnly: false }))
      .toBe('cancel_url · Mozilla/5.0 (iPhone)');
    expect(W.lookupRowDetail({ kind: 'log', action: 'gateway', outcome: 'opened', reason: null, httpStatus: null, attempt: null, ua: 'Mozilla/5.0 (Mac)', client: true, orderMatchOnly: false }))
      .toBe('Mozilla/5.0 (Mac)');
    expect(W.lookupRowDetail({ kind: 'log', action: 'webhook', outcome: 'error', reason: null, httpStatus: 500, attempt: null, ua: 'server-ua', client: false, orderMatchOnly: false }))
      .toBe('HTTP 500'); // a server row's UA is not the customer's browser
    expect(W.lookupRowDetail({ kind: 'log', action: 'checkout', outcome: 'refused', reason: 'expired', httpStatus: 409, attempt: 3, ua: null, client: false, orderMatchOnly: false }))
      .toBe('attempt 3 · HTTP 409'); // paLabel only names the attempt on a started checkout
  });

  it('notices: code, message, method, payment id and amount', () => {
    expect(W.lookupRowDetail({ kind: 'notice', code: '-2', message: 'Insufficient funds', method: 'VISA', paymentId: '0', amount: 10000, currency: 'USD', note: null, repeats: null }))
      .toBe('code -2 · “Insufficient funds” · VISA · payment id 0 · $100');
  });

  it('manual settlement: who and their reference; emails: delivery not tracked', () => {
    expect(W.lookupRowDetail({ kind: 'payment_settled', orderId: 'CH-1-MANUAL', amount: 5000, currency: 'USD', method: 'cash', settlementSource: 'manual', settledBy: 'fin@x.com', reference: 'R1' }))
      .toBe('by fin@x.com · ref R1 · $50');
    expect(W.lookupRowDetail({ kind: 'email', emailKind: 'payment_failed', deliveryTracked: false })).toBe('delivery not tracked');
    expect(W.lookupRowDetail({ kind: 'email', emailKind: 'confirmation', deliveryTracked: true })).toBe('');
  });

  it('refunds: who, PayHere’s ref or message, the reason, and the amount where the label lacks it', () => {
    expect(W.lookupRowDetail({ kind: 'refund', step: 'failed', amount: 12000, currency: 'USD', by: null, ref: null, message: 'Refund window closed', reason: null }))
      .toBe('“Refund window closed” · $120');
    expect(W.lookupRowDetail({ kind: 'refund', step: 'requested', amount: 12000, currency: 'USD', by: 'f@x.com', ref: null, message: null, reason: 'trip cancelled' }))
      .toBe('by f@x.com · trip cancelled');
    expect(W.lookupRowDetail({ kind: 'refund', step: 'confirmed', amount: 12000, currency: 'USD', by: 'f@x.com', ref: 'RF-1', message: null, reason: null }))
      .toBe('by f@x.com · ref RF-1');
  });

  it('a cancellation shows its reason unless it was the duplicate auto-close', () => {
    expect(W.lookupRowDetail({ kind: 'cancelled', by: 'f@x.com', reason: 'customer asked', paidOn: null })).toBe('customer asked');
    expect(W.lookupRowDetail({ kind: 'cancelled', by: 'system:duplicate-close', reason: 'duplicate — paid on CH-P', paidOn: 'CH-P' })).toBe('');
  });
});

describe('lookupRowTone', () => {
  it('colours log rows like the drawer and money rows by outcome', () => {
    expect(W.lookupRowTone({ kind: 'log', outcome: 'failed' })).toBe('var(--alert)');
    expect(W.lookupRowTone({ kind: 'notice', code: '2' })).toBe('var(--ok)');
    expect(W.lookupRowTone({ kind: 'notice', code: '-2' })).toBe('var(--alert)');
    expect(W.lookupRowTone({ kind: 'refund', step: 'confirmed' })).toBe('var(--ok)');
    expect(W.lookupRowTone({ kind: 'email' })).toBe('var(--idle)');
  });
});

describe('lookupGapText / lookupUnavailableText', () => {
  it('names every recording gap', () => {
    expect(W.lookupGapText('no_checkout_log')).toBe('Checkout attempts before 24 Sep 2026 weren’t recorded.');
    expect(W.lookupGapText('declines_may_be_missing')).toBe('PayHere declines before 26 Sep 2026 may be missing.');
    expect(W.lookupGapText('no_gateway_report')).toBe('Pay links and manage links don’t report opening PayHere — the customer may have reached it.');
    expect(W.lookupGapText('actor_not_recorded')).toBe('Who cancelled this, and why, wasn’t recorded.');
    expect(W.lookupGapText('a_new_gap')).toBe('a_new_gap');
  });

  it('says which sources failed to load, in words', () => {
    expect(W.lookupUnavailableText(['payments', 'payment_events', 'booking_checkout_event', 'refunds', 'notification_log']))
      .toBe('Incomplete — couldn’t load: payments, PayHere notices, checkout log, refunds, emails');
    expect(W.lookupUnavailableText(['refunds'])).toBe('Incomplete — couldn’t load: refunds');
  });
});
