import { describe, it, expect } from 'vitest';
import { emailQuotaAlert, emailSentToday, EMAIL_QUOTA_WARN_SHARE } from './emailQuota';
import { UsageMeter } from './usageMeter';
import { InMemoryUsageCounterRepo } from '../db/usageCounterRepo';
import { FakeAlertAdapter, ThrottledAlerts } from '../adapters/alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';

// The one new watchdog rule (spec 2026-10-13 §6): warn at 70 % of the Resend daily cap, so the
// owner upgrades BEFORE the cap — once it bites, the confirmation_email_failed alert can't be
// delivered either.

const T0 = new Date('2026-10-13T10:00:00.000Z');

describe('emailQuotaAlert', () => {
  it('is quiet below 70 % of the daily limit', () => {
    expect(EMAIL_QUOTA_WARN_SHARE).toBe(0.7);
    expect(emailQuotaAlert('2026-10-13', 69, 100)).toBeNull();
    expect(emailQuotaAlert('2026-10-13', 0, 100)).toBeNull();
  });

  it('fires a critical alert at 70 %, deduped per UTC day, naming the numbers', () => {
    const a = emailQuotaAlert('2026-10-13', 70, 100);
    expect(a).not.toBeNull();
    expect(a!.severity).toBe('critical');
    expect(a!.kind).toBe('email_quota_near');
    expect(a!.dedupeKey).toBe('2026-10-13');
    expect(a!.title).toContain('70 of 100');
    expect(a!.body).toContain('Resend');
  });

  it('rounds the threshold up for small limits', () => {
    // 70 % of 15 is 10.5 → 11 sends, not 10.
    expect(emailQuotaAlert('2026-10-13', 10, 15)).toBeNull();
    expect(emailQuotaAlert('2026-10-13', 11, 15)).not.toBeNull();
  });

  // 2026-11-02: re-sent every 30 min from 73 to 102 of 100, each send counted by the next one.
  it('pages once a UTC day however long the day stays over the threshold', async () => {
    const inner = new FakeAlertAdapter();
    let clock = new Date('2026-11-02T10:00:00.000Z');
    const alerts = new ThrottledAlerts(inner, new InMemoryAlertLogRepo(), { now: () => clock });
    await alerts.send(emailQuotaAlert('2026-11-02', 70, 100)!);
    clock = new Date('2026-11-02T10:31:00.000Z');
    await alerts.send(emailQuotaAlert('2026-11-02', 71, 100)!);
    clock = new Date('2026-11-02T23:59:00.000Z');
    await alerts.send(emailQuotaAlert('2026-11-02', 95, 100)!);
    expect(inner.sent.map((a) => a.title)).toEqual(['Email sends at 70 of 100 today']);
    clock = new Date('2026-11-03T00:05:00.000Z');
    await alerts.send(emailQuotaAlert('2026-11-03', 70, 100)!);
    expect(inner.sent).toHaveLength(2);
  });
});

describe('emailSentToday', () => {
  it('flushes the meter and reads today’s email.sent, ignoring other days and keys', async () => {
    const repo = new InMemoryUsageCounterRepo();
    const meter = new UsageMeter(repo, { now: () => T0, flushMs: 0 });
    await repo.add('2026-10-12', 'email.sent', 40);
    meter.bump('email.sent', 3);
    meter.bump('email.failed', 1);
    expect(await emailSentToday(T0, { meter, repo })).toBe(3);
  });
});
