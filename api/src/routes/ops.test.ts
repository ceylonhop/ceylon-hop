import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const deps = {
  auth: { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' },
  adminApiKey: 'adminkey',
};

describe('ops auth', () => {
  it('rejects unauthenticated access', async () => {
    const app = createApp(deps);
    const res = await app.request('/admin/ops/whoami');
    expect(res.status).toBe(401);
  });
  it('logs in with the support key and sets a session cookie', async () => {
    const app = createApp(deps);
    const login = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sup' }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ role: 'support' });
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('ch_ops=');
    const who = await app.request('/admin/ops/whoami', { headers: { cookie: cookie.split(';')[0] } });
    expect(await who.json()).toEqual({ role: 'support' });
  });
  it('honours x-admin-key as founder', async () => {
    const app = createApp(deps);
    const who = await app.request('/admin/ops/whoami', { headers: { 'x-admin-key': 'adminkey' } });
    expect(await who.json()).toEqual({ role: 'founder' });
  });
  it('rejects a bad login key', async () => {
    const app = createApp(deps);
    const res = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'nope' }),
    });
    expect(res.status).toBe(401);
  });
});
