import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { runWatchdog } from '../services/watchdog';
import { FakeAlertAdapter } from '../adapters/alerts';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { InMemoryBookingCheckoutEventRepo } from '../db/bookingCheckoutEventRepo';

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
    expect(await res.json()).toEqual({ stuckPending: 0, paidUnconfirmed: 0, recoveryEmails: 0, stuckRefunds: 0, overdueRideLists: 0, suppressed: 0 });
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
        mode: 'single',
        channel: 'website',
        input: { from: 'Colombo Airport', to: 'Ella', customer: { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94', country: 'LK' } },
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

  // Review of #774, finding 7: the job is handed config.TEAM_EMAILS (via createApp's teamEmails),
  // the same set the ops queue and the digest use, so the owner's own test checkout pages nobody.
  it('leaves a team test booking out of the sweep', async () => {
    const alerts = new FakeAlertAdapter();
    const stuck = {
      id: 'b-team', reference: 'CH-TEAM1', mode: 'single', channel: 'website', status: 'payment_pending',
      input: { from: 'Colombo Airport', to: 'Ella', customer: { firstName: 'O', lastName: 'W', email: 'owner@ceylonhop.com', whatsapp: '+94', country: 'LK' } },
      createdAt: new Date(Date.now() - 45 * 60_000).toISOString(), currency: 'USD', total: 5000, amountDueNow: 5000,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bookings: any = { list: async ({ status }: { status: string }) => (status === 'payment_pending' ? [stuck] : []) };
    const app = createApp({ adminApiKey: KEY, alerts, bookings, teamEmails: new Set(['owner@ceylonhop.com']) });
    const res = await app.request('/admin/jobs/watchdog', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    expect((await res.json()).stuckPending).toBe(0);
    expect(alerts.sent.filter((a) => a.kind === 'watchdog_stuck_pending')).toHaveLength(0);
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

  // The watchdog heartbeat, where an uptime monitor can see it. Staleness is reported
  // but does NOT move the status code yet: the cron still lands hours apart, and a red
  // health check on every gap would page constantly.
  it('reports the watchdog heartbeat when the alert ledger is wired', async () => {
    const alertLog = new InMemoryAlertLogRepo();
    const ranAt = new Date(Date.now() - 5 * 60_000);
    await runWatchdog(ranAt, { bookings: { list: async () => [] } as never, log: {} as never, alerts: new FakeAlertAdapter(), alertLog });
    const app = createApp({ alertLog, pingDb: async () => {} });
    const res = await app.request('/health/deep');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok', watchdog: { lastRunAt: ranAt.toISOString(), stale: false } });
  });

  it('a stale (or never-run) watchdog is reported but leaves the status 200', async () => {
    const app = createApp({ alertLog: new InMemoryAlertLogRepo(), pingDb: async () => {} });
    const res = await app.request('/health/deep');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok', watchdog: { lastRunAt: null, stale: true } });

    const alertLog = new InMemoryAlertLogRepo();
    await runWatchdog(new Date(Date.now() - 3 * 3600_000), { bookings: { list: async () => [] } as never, log: {} as never, alerts: new FakeAlertAdapter(), alertLog });
    const res2 = await createApp({ alertLog, pingDb: async () => {} }).request('/health/deep');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ status: 'ok', watchdog: { stale: true } });
  });

  it('plain /health stays static and never touches the DB', async () => {
    const app = createApp({ pingDb: async () => { throw new Error('must not be called'); } });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
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

  it('carries the payments line when the checkout attempt log is wired', async () => {
    const email = new FakeEmailAdapter();
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    await checkoutEvents.record({ action: 'checkout', outcome: 'succeeded', bookingId: '11111111-1111-4111-8111-111111111111', source: 'server' }, new Date(Date.now() - 60_000));
    const app = createApp({ adminApiKey: KEY, email, alertLog: new InMemoryAlertLogRepo(), checkoutEvents, digestTo: 'ops@ceylonhop.com' });
    await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    const digest = email.sent.find((m) => m.subject.includes('ops digest'));
    expect(digest!.text).toContain('Checkouts started: 1 · paid 0');
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

describe('POST /admin/jobs/watchdog — heartbeat', () => {
  it('stamps the alert ledger so the daily tick can tell whether the cron is alive', async () => {
    const alertLog = new InMemoryAlertLogRepo();
    const app = createApp({ adminApiKey: KEY, alertLog });
    const before = Date.now();
    const res = await app.request('/admin/jobs/watchdog', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    const at = await alertLog.lastSentAt('watchdog_tick', 'last');
    expect(at).not.toBeNull();
    expect(at!.getTime()).toBeGreaterThanOrEqual(before);
  });
});
