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

  it('carries the Google profile name through the session to whoami (avatar initials)', async () => {
    const googleVerifier = async () => ({ payload: {
      iss: 'https://accounts.google.com', aud: 'cid', email: 'f@x.com', email_verified: true, name: 'Sandra Wolker',
    } });
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const login = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const who = await app.request('/admin/ops/whoami', { headers: { cookie } });
    expect(who.status).toBe(200);
    expect((await who.json()).name).toBe('Sandra Wolker');
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

  it('403s a token whose email is not verified (email_verified:false)', async () => {
    // A signature-valid token for an allowlisted email, but Google says the email is unverified.
    const googleVerifier = async () => ({ payload: {
      iss: 'https://accounts.google.com', aud: 'cid', email: 'f@x.com', email_verified: false,
    } });
    const app = createApp({ auth, adminApiKey: 'k', googleVerifier });
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
    });
    expect(res.status).toBe(403);
  });

  it('fails closed (503 login_unavailable) when GOOGLE_OAUTH_CLIENT_ID or OPS_USERS is unset', async () => {
    const googleVerifier = async () => ({ payload: {
      iss: 'https://accounts.google.com', aud: 'cid', email: 'f@x.com', email_verified: true,
    } });
    for (const bad of [{ ...auth, googleClientId: '' }, { ...auth, opsUsers: '' }]) {
      const app = createApp({ auth: bad, adminApiKey: 'k', googleVerifier });
      const res = await app.request('/admin/ops/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('login_unavailable');
    }
  });
});
