import { describe, it, expect } from 'vitest';
import { app } from './app';

describe('GET /health', () => {
  it('returns 200 and { status: "ok" }', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
