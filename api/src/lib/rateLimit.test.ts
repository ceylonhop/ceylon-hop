import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimit } from './rateLimit';

// The limiter reports every 429 it serves (spec 2026-10-13 §1, `ratelimit.refused`), so the
// ops Health tab can show how often ordinary browsing is being turned away.

describe('rateLimit onLimited', () => {
  it('calls onLimited once per refused request and never for an allowed one', async () => {
    let refused = 0;
    const app = new Hono();
    app.use('/x', rateLimit({ windowMs: 60_000, max: 2, onLimited: () => { refused++; } }));
    app.post('/x', (c) => c.text('ok'));

    const post = () => app.request('/x', { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(refused).toBe(0);
    expect((await post()).status).toBe(429);
    expect((await post()).status).toBe(429);
    expect(refused).toBe(2);
  });

  it('works without the hook, as every existing caller does', async () => {
    const app = new Hono();
    app.use('/x', rateLimit({ windowMs: 60_000, max: 1 }));
    app.post('/x', (c) => c.text('ok'));
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429);
  });
});
