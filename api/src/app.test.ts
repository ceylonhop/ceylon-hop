import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from './app';

// Build a default app (fakes injected in NODE_ENV=test) rather than importing a module-level
// singleton — the eager `export const app = createApp()` was removed because it constructed a
// payment adapter at import time, which crashed production boot. See app.prod-boot.test.ts.
const app = createApp();

describe('GET /health', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns 200 and { status: "ok" }', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  // A prod deploy is otherwise unverifiable from outside: Render posts no deployment status,
  // so the running commit is the only proof that a promote actually rolled out.
  it('reports the running commit (short sha) from RENDER_GIT_COMMIT', async () => {
    vi.stubEnv('RENDER_GIT_COMMIT', '10809bea1f2e3d4c5b6a79880123456789abcdef');
    const res = await app.request('/health');
    expect(await res.json()).toEqual({ status: 'ok', commit: '10809be' });
  });

  it('reports commit: null off Render (local dev, CI) rather than omitting the key', async () => {
    vi.stubEnv('RENDER_GIT_COMMIT', '');
    const res = await app.request('/health');
    expect(await res.json()).toEqual({ status: 'ok', commit: null });
  });

  it('returns a server-owned request id without changing the response body', async () => {
    const res = await app.request('/health', { headers: { 'x-request-id': 'caller-controlled' } });
    const requestId = res.headers.get('x-request-id');

    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestId).not.toBe('caller-controlled');
    expect(await res.json()).toEqual({ status: 'ok', commit: null });
  });

  it('sends CORS headers so the browser can call it cross-origin', async () => {
    const res = await app.request('/health', { headers: { origin: 'http://localhost:4173' } });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
    expect(res.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('x-request-id');
  });
});
