import { describe, it, expect } from 'vitest';
import { MeteredEmailAdapter } from './meteredEmail';
import { DELIVERED, type EmailAdapter, type EmailMessage, type SendOutcome } from './email';
import { UsageMeter } from '../services/usageMeter';
import { InMemoryUsageCounterRepo } from '../db/usageCounterRepo';

// Counts provider sends against the Resend daily/monthly caps (spec 2026-10-13 §3). Wraps the
// RAW provider adapter in server.ts — below the guard — so alerts and the digest count too.

const msg: EmailMessage = { to: 'a@example.com', subject: 's', html: '<p>h</p>', text: 'h' };
const T0 = new Date('2026-10-13T10:00:00.000Z');

function harness(inner: EmailAdapter) {
  const repo = new InMemoryUsageCounterRepo();
  const meter = new UsageMeter(repo, { now: () => T0, flushMs: 0 });
  const adapter = new MeteredEmailAdapter(inner, meter);
  const counts = async () => {
    await meter.flush();
    return Object.fromEntries((await repo.range('2026-10-13', '2026-10-13')).map((r) => [r.key, r.n]));
  };
  return { adapter, counts };
}

describe('MeteredEmailAdapter', () => {
  it('counts an accepted send as email.sent and passes the outcome through', async () => {
    const outcome: SendOutcome = { delivered: true, provider: 'resend', providerMessageId: 'm1' };
    const { adapter, counts } = harness({ send: async () => outcome });
    expect(await adapter.send(msg)).toEqual(outcome);
    expect(await counts()).toEqual({ 'email.sent': 1 });
  });

  it('treats a void outcome as delivered, as the rest of the code does', async () => {
    const { adapter, counts } = harness({ send: async () => undefined });
    await adapter.send(msg);
    expect(await counts()).toEqual({ 'email.sent': 1 });
  });

  it('counts a suppressed send separately — it never reached the provider', async () => {
    const outcome: SendOutcome = { delivered: false, reason: 'suppressed_allowlist' };
    const { adapter, counts } = harness({ send: async () => outcome });
    expect(await adapter.send(msg)).toEqual(outcome);
    expect(await counts()).toEqual({ 'email.suppressed': 1 });
  });

  it('counts a throw as email.failed and rethrows it unchanged', async () => {
    const boom = new Error('resend_send_failed_429');
    const { adapter, counts } = harness({ send: async () => { throw boom; } });
    await expect(adapter.send(msg)).rejects.toBe(boom);
    expect(await counts()).toEqual({ 'email.failed': 1 });
  });

  it('DELIVERED is the plain accepted outcome', async () => {
    const { adapter, counts } = harness({ send: async () => DELIVERED });
    await adapter.send(msg);
    expect(await counts()).toEqual({ 'email.sent': 1 });
  });
});
