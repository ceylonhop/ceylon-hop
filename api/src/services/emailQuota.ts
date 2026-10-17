import type { Alert } from '../adapters/alerts';
import type { UsageCounterRepo } from '../db/usageCounterRepo';
import { utcDay, type UsageMeter } from './usageMeter';

// The one usage rule the watchdog carries (spec 2026-10-13 §6). Resend's free plan stops at 100
// sends a day; past it every send fails — including the confirmation_email_failed alert that would
// have said so. Warning at 70 % gives the owner the day to upgrade, and dedupes per UTC day so a
// busy day pages once. Kept apart from systemHealth.ts so watchdog.ts can import it without a cycle.

export const EMAIL_QUOTA_WARN_SHARE = 0.7;

export interface UsageSource {
  meter: UsageMeter;
  repo: UsageCounterRepo;
}

// Today's provider-accepted sends, pending meter counts included.
export async function emailSentToday(now: Date, usage: UsageSource): Promise<number> {
  await usage.meter.flush();
  const day = utcDay(now);
  return (await usage.repo.range(day, day))
    .filter((r) => r.key === 'email.sent')
    .reduce((sum, r) => sum + r.n, 0);
}

export function emailQuotaAlert(day: string, sentToday: number, dailyLimit: number): Alert | null {
  const threshold = Math.ceil(dailyLimit * EMAIL_QUOTA_WARN_SHARE);
  if (sentToday < threshold) return null;
  return {
    severity: 'critical',
    kind: 'email_quota_near',
    title: `Email sends at ${sentToday} of ${dailyLimit} today`,
    body:
      `${sentToday} emails have gone out today (UTC) against a Resend daily limit of ${dailyLimit}. ` +
      `Past the limit every send fails — customer confirmations and these alerts alike. ` +
      `Upgrade the Resend plan (then raise EMAIL_DAILY_LIMIT), or expect failures until the day resets.`,
    dedupeKey: day,
  };
}
