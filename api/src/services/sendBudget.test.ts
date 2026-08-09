import { describe, it, expect } from 'vitest';
import { SendBudget, burstAlert } from './sendBudget';

describe('SendBudget', () => {
  it('allows sends up to the cap, then reports itself exhausted', () => {
    const b = new SendBudget(3);
    expect(b.tryClaim()).toBe(true);
    expect(b.tryClaim()).toBe(true);
    expect(b.tryClaim()).toBe(true);
    expect(b.tryClaim()).toBe(false);
    expect(b.sent).toBe(3);
    expect(b.exhausted).toBe(true);
  });

  it('refuses a multi-send claim that does not fit, and spends nothing', () => {
    const b = new SendBudget(5);
    expect(b.tryClaim(3)).toBe(true);
    expect(b.remaining).toBe(2);
    // A batch of 4 does not fit in the remaining 2 — and must not partially spend.
    expect(b.tryClaim(4)).toBe(false);
    expect(b.remaining).toBe(2);
    expect(b.sent).toBe(3);
  });

  it('tallies suppressed sends by kind and keeps a bounded sample of references', () => {
    const b = new SendBudget(0);
    for (let i = 0; i < 8; i++) b.suppress('review_request', `CH-R${i}`);
    b.suppress('trip_reminder', 'CH-T1');

    const r = b.report();
    expect(r.sent).toBe(0);
    expect(r.suppressed).toBe(9);
    expect(r.kinds).toEqual({ review_request: 8, trip_reminder: 1 });
    // A burst alert must stay readable — the sample is capped, the count is not.
    expect(r.sample).toHaveLength(5);
    expect(r.sample[0]).toBe('CH-R0');
  });

  it('a zero cap allows nothing', () => {
    const b = new SendBudget(0);
    expect(b.tryClaim()).toBe(false);
    expect(b.exhausted).toBe(true);
  });

  it('reports nothing suppressed when the run stayed under the cap', () => {
    const b = new SendBudget(10);
    b.tryClaim(4);
    expect(b.report().suppressed).toBe(0);
    expect(b.anySuppressed).toBe(false);
  });
});

describe('burstAlert', () => {
  it('says nothing when nothing was suppressed', () => {
    const b = new SendBudget(10);
    b.tryClaim(2);
    expect(burstAlert(b, 'notifications')).toBeNull();
  });

  it('pages critical, names the counts, and points at the likely cause', () => {
    const b = new SendBudget(2);
    b.tryClaim(2);
    for (let i = 0; i < 400; i++) b.suppress('review_request', `CH-A${i}`);

    const alert = burstAlert(b, 'notifications');
    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe('critical');
    expect(alert?.kind).toBe('notification_burst_suppressed');
    expect(alert?.title).toMatch(/2 sent/);
    expect(alert?.title).toMatch(/400 held back/);
    expect(alert?.body).toMatch(/review_request: 400/);
    expect(alert?.body).toMatch(/CH-A0/);
    // The point of the alert is that a human decides what happens next.
    expect(alert?.body).toMatch(/migration or status backfill/i);
    expect(alert?.body).toMatch(/NOTIFY_MAX_PER_RUN/);
  });

  it('dedupes per tick, so a persisting burst pages once per cooldown', () => {
    const b = new SendBudget(0);
    b.suppress('trip_reminder', 'CH-1');
    expect(burstAlert(b, 'notifications')?.dedupeKey).toBe('notifications');
    expect(burstAlert(b, 'watchdog')?.dedupeKey).toBe('watchdog');
  });
});
