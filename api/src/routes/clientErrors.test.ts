import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakeAlertAdapter, ThrottledAlerts } from '../adapters/alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';

const post = (app: ReturnType<typeof createApp>, body: string) =>
  app.request('/errors/client', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

describe('POST /errors/client', () => {
  const mk = () => {
    const inner = new FakeAlertAdapter();
    const app = createApp({ alerts: new ThrottledAlerts(inner, new InMemoryAlertLogRepo()) });
    return { inner, app };
  };

  it('accepts a valid beacon with 204 and raises a warning alert', async () => {
    const { inner, app } = mk();
    const res = await post(app, JSON.stringify({ message: 'TypeError: x is undefined', url: 'https://ceylonhop.com/booking.html', stack: 'at pay()' }));
    expect(res.status).toBe(204);
    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0].severity).toBe('warning');
    expect(inner.sent[0].kind).toBe('client_error');
    expect(inner.sent[0].body).toContain('booking.html');
  });

  it('throttles repeats of the same message', async () => {
    const { inner, app } = mk();
    await post(app, JSON.stringify({ message: 'same boom' }));
    await post(app, JSON.stringify({ message: 'same boom' }));
    expect(inner.sent).toHaveLength(1);
  });

  it('rejects an invalid body with 400 and no alert', async () => {
    const { inner, app } = mk();
    expect((await post(app, JSON.stringify({ nope: true }))).status).toBe(400);
    expect((await post(app, 'not json')).status).toBe(400);
    expect(inner.sent).toHaveLength(0);
  });

  it('rejects oversized payloads with 413', async () => {
    const { app } = mk();
    const res = await post(app, JSON.stringify({ message: 'x'.repeat(3000) }));
    expect(res.status).toBe(413);
  });

  it('still returns 204 when the alert adapter blows up', async () => {
    const boom = { send: async () => { throw new Error('channel down'); } };
    const app = createApp({ alerts: boom });
    const res = await post(app, JSON.stringify({ message: 'boom' }));
    expect(res.status).toBe(204);
  });

  it('buckets messages varying only by ids/hex/digits onto one dedupe key (BI8)', async () => {
    const { inner, app } = mk();
    await post(app, JSON.stringify({ message: 'TypeError: cannot read x at 0xdeadbeef id 12345' }));
    await post(app, JSON.stringify({ message: 'TypeError: cannot read x at 0xfeedface id 99999' }));
    // Same normalized signature → the throttle collapses them to a single delivered alert,
    // so a beacon can't flood the founder by appending a random token each time.
    expect(inner.sent).toHaveLength(1);
  });

  it('is rate limited per IP like other public write endpoints', async () => {
    const { app } = mk();
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const res = await post(app, JSON.stringify({ message: `m${i}` }));
      if (res.status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});
