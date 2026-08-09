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

// ── Claim-then-send (notification safety rails, slice 3) ───────────────────
describe('InMemoryNotificationLogRepo — claim/release', () => {
  it('grants the claim once, then refuses it', async () => {
    const log = new InMemoryNotificationLogRepo();
    expect(await log.claim('b1', 'trip_reminder')).toBe(true);
    expect(await log.claim('b1', 'trip_reminder')).toBe(false);
  });

  it('claiming marks it sent, so wasSent agrees', async () => {
    const log = new InMemoryNotificationLogRepo();
    await log.claim('b1', 'trip_reminder');
    expect(await log.wasSent('b1', 'trip_reminder')).toBe(true);
  });

  it('releasing hands the claim back for a later run', async () => {
    const log = new InMemoryNotificationLogRepo();
    await log.claim('b1', 'trip_reminder');
    await log.release('b1', 'trip_reminder');
    expect(await log.wasSent('b1', 'trip_reminder')).toBe(false);
    expect(await log.claim('b1', 'trip_reminder')).toBe(true);
  });

  it('keeps claims separate per booking and per kind', async () => {
    const log = new InMemoryNotificationLogRepo();
    expect(await log.claim('b1', 'trip_reminder')).toBe(true);
    expect(await log.claim('b2', 'trip_reminder')).toBe(true);
    expect(await log.claim('b1', 'review_request')).toBe(true);
  });
});
