import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

describe('ops Google login route', () => {
  it('verifies the ID token, allowlist-checks, and sets the session cookie', async () => {
    const googleVerifier = async () => ({ payload: {
      iss: 'https://accounts.google.com', aud: 'cid', email: 'f@x.com', email_verified: true,
    } });
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'f@x.com', role: 'founder' });
    expect(res.headers.get('set-cookie')).toContain('ch_ops=');
  });

  it('403s a verified email that is not in OPS_USERS', async () => {
    const googleVerifier = async () => ({ payload: {
      iss: 'https://accounts.google.com', aud: 'cid', email: 'stranger@x.com', email_verified: true,
    } });
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(res.status).toBe(403);
  });

  it('401s an invalid token', async () => {
    const googleVerifier = async () => { throw new Error('bad signature'); };
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(res.status).toBe(401);
  });
});
