import { describe, it, expect } from 'vitest';
import { createApp } from './app';

// Build a default app (fakes injected in NODE_ENV=test) rather than importing a module-level
// singleton — the eager `export const app = createApp()` was removed because it constructed a
// payment adapter at import time, which crashed production boot. See app.prod-boot.test.ts.
const app = createApp();

describe('GET /health', () => {
  it('returns 200 and { status: "ok" }', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('sends CORS headers so the browser can call it cross-origin', async () => {
    const res = await app.request('/health', { headers: { origin: 'http://localhost:4173' } });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });
});
