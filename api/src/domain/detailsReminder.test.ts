import { describe, it, expect } from 'vitest';
import { detailsReminderDue, type DetailsReminderFacts } from './detailsReminder';

const DAY = 24 * 3600_000;
const EPOCH = new Date('2026-10-01T00:00:00Z');
const NOW = new Date('2026-10-20T10:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const base: DetailsReminderFacts = {
  missing: true, active: true, datePassed: false, paused: false,
  paidAt: ago(3), firstSentAt: null, secondSentAt: null,
};
const due = (over: Partial<DetailsReminderFacts>) => detailsReminderDue({ ...base, ...over }, NOW, EPOCH);

describe('detailsReminderDue', () => {
  it('sends the first reminder two days after payment, not before', () => {
    expect(due({ paidAt: ago(1.9) })).toBeNull();
    expect(due({ paidAt: ago(2) })).toBe('details_reminder_1');
  });

  it('sends the second at seven days, only three days after the first', () => {
    expect(due({ paidAt: ago(6.9), firstSentAt: ago(4) })).toBeNull();
    expect(due({ paidAt: ago(7), firstSentAt: ago(5) })).toBe('details_reminder_2');
    // A tick outage: first went out yesterday although payment was 9 days ago — wait.
    expect(due({ paidAt: ago(9), firstSentAt: ago(1) })).toBeNull();
  });

  it('never sends a third', () => {
    expect(due({ paidAt: ago(30), firstSentAt: ago(25), secondSentAt: ago(20) })).toBeNull();
  });

  it('stays quiet once the details are in, the booking is closed, the date passed, or ops paused it', () => {
    expect(due({ missing: false })).toBeNull();
    expect(due({ active: false })).toBeNull();
    expect(due({ datePassed: true })).toBeNull();
    expect(due({ paused: true })).toBeNull();
  });

  it('never reminds about a payment from before the release, or one with no settle time', () => {
    expect(due({ paidAt: new Date('2026-09-30T23:59:00Z') })).toBeNull();
    expect(due({ paidAt: null })).toBeNull();
  });
});
