import { describe, it, expect } from 'vitest';
import { InMemoryNotificationLogRepo } from './notificationLogRepo';

describe('InMemoryNotificationLogRepo', () => {
  it('records and reports sent notifications per (booking, kind), idempotently', async () => {
    const log = new InMemoryNotificationLogRepo();
    expect(await log.wasSent('b1', 'trip_reminder')).toBe(false);
    await log.markSent('b1', 'trip_reminder');
    expect(await log.wasSent('b1', 'trip_reminder')).toBe(true);
    expect(await log.wasSent('b1', 'review_request')).toBe(false); // different kind
    expect(await log.wasSent('b2', 'trip_reminder')).toBe(false); // different booking
    await log.markSent('b1', 'trip_reminder'); // idempotent — no throw, still sent
    expect(await log.wasSent('b1', 'trip_reminder')).toBe(true);
  });
});
