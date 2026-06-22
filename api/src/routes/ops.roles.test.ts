import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };

async function sessionCookie(app: ReturnType<typeof createApp>, key: string) {
  const res = await app.request('/admin/ops/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
  });
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('founder gate', () => {
  it('blocks support from the finance endpoint, allows founder', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const support = await sessionCookie(app, 'sup');
    const founder = await sessionCookie(app, 'fou');
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: support } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: founder } })).status).toBe(200);
  });
});
