import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0062_resend_communication_events.sql', import.meta.url),
  'utf8',
);
const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

describe('0062_resend_communication_events', () => {
  it('allows each frozen signed-provider event without changing existing event names', () => {
    for (const eventType of [
      'planned', 'suppressed', 'send_attempted', 'provider_accepted', 'send_failed',
      'provider_sent', 'delivered', 'delayed', 'provider_failed', 'bounced', 'complained',
    ]) {
      expect(migration).toContain(`'${eventType}'`);
    }
  });

  it('is the latest journal entry', () => {
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 62,
      tag: '0062_resend_communication_events',
      when: 1790899200000,
    });
  });
});
