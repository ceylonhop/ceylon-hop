import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
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
    expect(await res.json()).toEqual({ stuckPending: 0, paidUnconfirmed: 0 });
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
