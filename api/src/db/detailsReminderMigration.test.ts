import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TAG = '0073_details_reminder_kinds';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('keeps every existing email kind and adds the two reminders', () => {
    for (const k of ['confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice',
      'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received',
      'schedule_set', 'details_reminder_1', 'details_reminder_2']) {
      expect(sql).toContain(`'${k}'`);
    }
  });
  it('changes no rows and drops no table', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('is journalled after every earlier entry', () => {
    const i = journal.entries.findIndex((e) => e.tag === TAG);
    expect(i).toBeGreaterThan(0);
    expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
  });
});
