import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { runWatchdog } from '../services/watchdog';
import { FakeAlertAdapter } from '../adapters/alerts';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';

const KEY = 'test-admin-key';

describe('POST /admin/jobs/watchdog (M17)', () => {
  it('requires the admin key', async () => {
    const app = createApp({ adminApiKey: KEY });
    const res = await app.request('/admin/jobs/watchdog', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('runs the sweep and returns counts', async () => {
    const alerts = new FakeAlertAdapter();
    const app = createApp({ adminApiKey: KEY, alerts });
    const res = await app.request('/admin/jobs/watchdog', {
      method: 'POST',
      headers: { 'x-admin-key': KEY },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stuckPending: 0, paidUnconfirmed: 0, recoveryEmails: 0 });
  });

  // BI1 — a fresh stuck-pending booking pages the founder, but a long-abandoned cart (which
  // never leaves payment_pending) must stop paging on every sweep.
  it('alerts a recently-stuck pending booking but not a long-abandoned one', async () => {
    const alerts = new FakeAlertAdapter();
    const now = new Date('2026-07-01T12:00:00Z');
    const mk = (reference: string, minsAgo: number) =>
      ({
        id: reference,
        reference,
        status: 'payment_pending',
        createdAt: new Date(now.getTime() - minsAgo * 60_000).toISOString(),
        currency: 'USD',
        total: 5000,
        amountDueNow: 5000,
      }) as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bookings: any = { list: async ({ status }: { status: string }) => (status === 'payment_pending' ? [mk('R-FRESH', 45), mk('R-OLD', 8 * 60)] : []) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log: any = { wasSent: async () => false };

    const r = await runWatchdog(now, { bookings, log, alerts });
    expect(r.stuckPending).toBe(1);
    const titles = alerts.sent.map((a) => a.title).join(' | ');
    expect(titles).toContain('R-FRESH');
    expect(titles).not.toContain('R-OLD');
  });
});

describe('GET /health/deep (M17)', () => {
  it('reports skipped without a pingDb dep (unit/dev in-memory)', async () => {
    const app = createApp();
    const res = await app.request('/health/deep');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'skipped' });
  });

  it('reports ok when the DB answers', async () => {
    const app = createApp({ pingDb: async () => {} });
    const res = await app.request('/health/deep');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('503s and alerts when the DB is down', async () => {
    const alerts = new FakeAlertAdapter();
    const app = createApp({ alerts, pingDb: async () => { throw new Error('connection refused'); } });
    const res = await app.request('/health/deep');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', db: 'down' });
    expect(alerts.sent[0]?.kind).toBe('db_down');
  });

  it('plain /health stays static and never touches the DB', async () => {
    const app = createApp({ pingDb: async () => { throw new Error('must not be called'); } });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('daily ops digest rides /admin/jobs/notifications (M17)', () => {
  it('emails the digest when digestTo is set and reports digest:true', async () => {
    const email = new FakeEmailAdapter();
    const alertLog = new InMemoryAlertLogRepo();
    await alertLog.shouldSend('payhere_amount', 'x', 60_000, new Date()); // one delivered alert
    const app = createApp({ adminApiKey: KEY, email, alertLog, digestTo: 'ops@ceylonhop.com' });
    const res = await app.request('/admin/jobs/notifications', {
      method: 'POST',
      headers: { 'x-admin-key': KEY },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).digest).toBe(true);
    const digest = email.sent.find((m) => m.subject.includes('ops digest'));
    expect(digest).toBeTruthy();
    expect(digest!.to).toBe('ops@ceylonhop.com');
    expect(digest!.text).toContain('payhere_amount: 1');
    expect(digest!.text).toContain('Bookings created (24h): 0');
  });

  it('sends the digest at most once per day across repeated ticks (BI4)', async () => {
    const email = new FakeEmailAdapter();
    const alertLog = new InMemoryAlertLogRepo();
    const app = createApp({ adminApiKey: KEY, email, alertLog, digestTo: 'ops@ceylonhop.com' });
    const tick = () => app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect((await (await tick()).json()).digest).toBe(true);
    expect((await (await tick()).json()).digest).toBe(false);
    expect(email.sent.filter((m) => m.subject.includes('ops digest'))).toHaveLength(1);
  });

  it('skips the digest silently when digestTo is unset', async () => {
    const email = new FakeEmailAdapter();
    const app = createApp({ adminApiKey: KEY, email });
    const res = await app.request('/admin/jobs/notifications', {
      method: 'POST',
      headers: { 'x-admin-key': KEY },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).digest).toBe(false);
    expect(email.sent.filter((m) => m.subject.includes('ops digest'))).toHaveLength(0);
  });

  it('a digest failure never blocks the notifications result', async () => {
    const email = {
      send: async (m: { subject: string }) => {
        if (m.subject.includes('ops digest')) throw new Error('digest send failed');
      },
    };
    const app = createApp({ adminApiKey: KEY, email, digestTo: 'ops@ceylonhop.com' });
    const res = await app.request('/admin/jobs/notifications', {
      method: 'POST',
      headers: { 'x-admin-key': KEY },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.digest).toBe(false);
    expect(body).toHaveProperty('staleSharedHolds');
  });
});
