import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

// Spec §5/§7 "Dev bypass safety": the e2e signed-session helper (POST /admin/ops/dev-login)
// must refuse to run when NODE_ENV === 'production'. AppDeps.auth gets an additive
// `nodeEnv` override (mirrors opsUsers/googleClientId/sessionSecret) so this can be
// tested without mutating process.env.
function appFor(nodeEnv: string) {
  return createApp({
    auth: { opsUsers: 'op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek', nodeEnv },
    adminApiKey: 'k',
  });
}

describe('dev-login bypass', () => {
  it('works in development/test for an allowlisted email', async () => {
    const app = appFor('test');
    const res = await app.request('/admin/ops/dev-login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'op@x.com' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('ch_ops=');
  });

  it('refuses in production (404, no cookie)', async () => {
    const res = await appFor('production').request('/admin/ops/dev-login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'op@x.com' }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
