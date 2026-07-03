import { describe, it, expect, vi } from 'vitest';
import { FakeEmailAdapter } from './email';
import { EmailAlertAdapter, FakeAlertAdapter, LogAlertAdapter, ThrottledAlerts } from './alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';

describe('EmailAlertAdapter', () => {
  it('formats severity + title into a compact email to the ops address', async () => {
    const email = new FakeEmailAdapter();
    await new EmailAlertAdapter(email, 'ops@ceylonhop.com').send({
      severity: 'critical',
      kind: 'webhook_signature',
      title: 'PayHere signature failed',
      body: 'ref CH-XXX',
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('ops@ceylonhop.com');
    expect(email.sent[0].subject).toContain('[CRITICAL]');
    expect(email.sent[0].subject).toContain('PayHere signature failed');
    expect(email.sent[0].text).toContain('ref CH-XXX');
    expect(email.sent[0].text).toContain('webhook_signature');
  });
});

describe('LogAlertAdapter', () => {
  it('writes one console.error line and never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await new LogAlertAdapter().send({ severity: 'warning', kind: 'k', title: 't', body: 'b' });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain('[alert:warning]');
    errSpy.mockRestore();
  });
});

describe('ThrottledAlerts', () => {
  const alert = { severity: 'critical' as const, kind: 'k', title: 't', body: 'b', dedupeKey: 'x' };
  const mk = (nowMs: { t: number }) => {
    const inner = new FakeAlertAdapter();
    const alerts = new ThrottledAlerts(inner, new InMemoryAlertLogRepo(), {
      cooldownMs: 30 * 60_000,
      now: () => new Date(nowMs.t),
    });
    return { inner, alerts };
  };

  it('sends the first alert, suppresses repeats inside the cooldown', async () => {
    const now = { t: 0 };
    const { inner, alerts } = mk(now);
    await alerts.send(alert);
    await alerts.send(alert);
    now.t = 29 * 60_000;
    await alerts.send(alert);
    expect(inner.sent).toHaveLength(1);
  });

  it('sends again after the cooldown', async () => {
    const now = { t: 0 };
    const { inner, alerts } = mk(now);
    await alerts.send(alert);
    now.t = 31 * 60_000;
    await alerts.send(alert);
    expect(inner.sent).toHaveLength(2);
  });

  it('different dedupe keys are independent', async () => {
    const now = { t: 0 };
    const { inner, alerts } = mk(now);
    await alerts.send(alert);
    await alerts.send({ ...alert, dedupeKey: 'y' });
    expect(inner.sent).toHaveLength(2);
  });

  it('dedupeKey defaults to the kind', async () => {
    const now = { t: 0 };
    const { inner, alerts } = mk(now);
    await alerts.send({ severity: 'info', kind: 'same', title: 'a', body: '1' });
    await alerts.send({ severity: 'info', kind: 'same', title: 'b', body: '2' });
    expect(inner.sent).toHaveLength(1);
  });

  it('never throws even when the inner adapter does (alerting must not break requests)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = { send: async () => { throw new Error('smtp down'); } };
    const alerts = new ThrottledAlerts(boom, new InMemoryAlertLogRepo());
    await expect(alerts.send(alert)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
