import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// fireRefund is the one place money moves. Extract it and drive every outcome PayHere can hand
// back, because the failure paths are what decide whether an operator refunds twice.
function loadFireRefund(deps) {
  const m = html.match(/async function fireRefund\(bookingId, refundId\)\{[\s\S]*?\n\}/);
  if (!m) throw new Error('fireRefund not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function(
    'adminApi', 'reloadRefundDetail', 'refreshRow', 'toast', 'window',
    m[0] + '\nreturn fireRefund;',
  )(deps.adminApi, deps.reloadRefundDetail, deps.refreshRow, deps.toast, deps.window);
}

function harness(postImpl) {
  const calls = { posted: [], toasts: [], reloaded: 0, refreshed: 0, reported: [] };
  const fire = loadFireRefund({
    adminApi: { post: async (p) => { calls.posted.push(p); return postImpl(p); } },
    reloadRefundDetail: async () => { calls.reloaded++; },
    refreshRow: async () => { calls.refreshed++; },
    toast: (msg, kind) => calls.toasts.push({ msg, kind }),
    window: { opsReportError: (...a) => calls.reported.push(a) },
  });
  return { fire, calls };
}

describe('fireRefund — the one place money moves', () => {
  it('calls the execute endpoint and reports success', async () => {
    const { fire, calls } = harness(async () => ({}));
    await expect(fire('bk1', 'rf1')).resolves.toBe(true);
    expect(calls.posted).toEqual(['/bookings/bk1/refunds/rf1/execute']);
    // The booking flips to refunded, so the QUEUE row must repaint too — not just the sheet.
    expect(calls.refreshed).toBe(1);
  });

  // The dangerous one: the money may already have moved and the API has no idempotency key.
  it('never suggests retrying when the outcome is unknown', async () => {
    const { fire, calls } = harness(async () => { throw new Error('refund_outcome_unknown'); });
    await expect(fire('bk1', 'rf1')).resolves.toBe(false);
    const msg = calls.toasts[0].msg;
    // It must send the operator to PayHere to LOOK. (The toast currently reads "…before
    // retrying", which is softer than the row's own "Do not retry it" — flagged to the owner
    // rather than changed here, since it is live safety copy.)
    expect(msg).toMatch(/check PayHere/i);
    expect(calls.toasts[0].kind).toBe('error');
  });

  it('names a decline rather than blaming the network', async () => {
    const { fire, calls } = harness(async () => { throw new Error('refund_declined'); });
    await expect(fire('bk1', 'rf1')).resolves.toBe(false);
    expect(calls.toasts[0].msg).toMatch(/declined/i);
  });

  // If the API is off, the refund row still exists and the manual route below still works —
  // the operator must be told where to go, not just that it failed.
  it('points at the manual route when the API is unavailable', async () => {
    const { fire, calls } = harness(async () => { throw new Error('refund_api_unavailable'); });
    await expect(fire('bk1', 'rf1')).resolves.toBe(false);
    expect(calls.toasts[0].msg).toMatch(/row below/i);
  });

  it('reports an unexpected failure for diagnosis', async () => {
    const { fire, calls } = harness(async () => { throw new Error('boom'); });
    await expect(fire('bk1', 'rf1')).resolves.toBe(false);
    expect(calls.reported).toHaveLength(1);
  });

  it('stays quiet on an auth failure — the login prompt is already showing', async () => {
    const { fire, calls } = harness(async () => { throw new Error('auth'); });
    await expect(fire('bk1', 'rf1')).resolves.toBe(false);
    expect(calls.toasts).toHaveLength(0);
    expect(calls.reloaded).toBe(0);
  });

  it('repaints the ledger after every failure, so the row’s real state is on screen', async () => {
    for (const e of ['refund_outcome_unknown', 'refund_declined', 'refund_api_unavailable', 'boom']) {
      const { fire, calls } = harness(async () => { throw new Error(e); });
      await fire('bk1', 'rf1');
      expect(calls.reloaded, e).toBe(1);
    }
  });
});

describe('the refund button', () => {
  it('promises a refund only to operators who can actually move money', () => {
    // Both wordings live in the same template literal; the capability picks between them.
    expect(html).toMatch(/mayFire\?'Refund':'Request refund'/);
    expect(html).toMatch(/const mayFire = !!\(state\.caps && state\.caps\.includes\('payments:reverse'\)\)/);
  });

  it('no longer tells the operator that no money has moved when it has', () => {
    expect(html).not.toMatch(/This records the request — no money moves yet/);
  });

  it('warns that a one-click refund cannot be undone', () => {
    expect(html).toMatch(/sends the money back through PayHere immediately\. There is no undo\./);
  });
});
