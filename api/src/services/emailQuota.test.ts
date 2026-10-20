import { describe, it, expect } from 'vitest';
import { emailQuotaAlert, emailSentToday, EMAIL_QUOTA_WARN_SHARE } from './emailQuota';
import { UsageMeter } from './usageMeter';
import { InMemoryUsageCounterRepo } from '../db/usageCounterRepo';

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
