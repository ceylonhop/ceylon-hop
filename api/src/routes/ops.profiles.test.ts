import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryOpsUserProfileRepo, type OpsUserProfileRepo } from '../db/opsUserProfileRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = { opsUsers: 'f@x.com:founder,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

function verifierFor(email: string, name?: string) {
  return async () => ({ payload: {
    iss: 'https://accounts.google.com', aud: 'cid', email, email_verified: true, ...(name ? { name } : {}),
  } });
}
async function login(app: ReturnType<typeof createApp>) {
  const res = await app.request('/admin/ops/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'tok' }),
  });
  return res;
}
// A session cookie carrying (or omitting) a Google display name, minted without Google.
async function cookie(email: string, name?: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now(), name); return ctx.text('ok'); });
  return (await c.request('/')).headers.get('set-cookie')!.split(';')[0];
}

describe('ops user profiles — capturing the Google display name', () => {
  it('stores the profile name at sign-in', async () => {
    const opsUserProfiles = new InMemoryOpsUserProfileRepo();
    const app = createApp({ auth, adminApiKey: 'k', opsUserProfiles, googleVerifier: verifierFor('f@x.com', 'Sandra Wolker') });
    expect((await login(app)).status).toBe(200);
    expect((await opsUserProfiles.namesByEmail()).get('f@x.com')).toBe('Sandra Wolker');
  });

  // Nobody re-authenticates just because we shipped a table. Sessions last 7 days, so without
  // this the picker would show email local parts for up to a week after deploy; whoami runs on
  // every app boot, so the name lands on the next page load instead.
  it('backfills from a live session on whoami, without a fresh sign-in', async () => {
    const opsUserProfiles = new InMemoryOpsUserProfileRepo();
    const app = createApp({ auth, adminApiKey: 'k', opsUserProfiles });
    const res = await app.request('/admin/ops/whoami', { headers: { cookie: await cookie('f@x.com', 'Sandra Wolker') } });
    expect(res.status).toBe(200);
    expect((await opsUserProfiles.namesByEmail()).get('f@x.com')).toBe('Sandra Wolker');
  });

  it('stores nothing for a session with no name (dev-login, legacy cookies)', async () => {
    const opsUserProfiles = new InMemoryOpsUserProfileRepo();
    const app = createApp({ auth, adminApiKey: 'k', opsUserProfiles });
    expect((await app.request('/admin/ops/whoami', { headers: { cookie: await cookie('f@x.com') } })).status).toBe(200);
    expect(await opsUserProfiles.namesByEmail()).toEqual(new Map());
  });

  // Migrations here are applied by hand AFTER the code deploys, so for a window the table does
  // not exist and every profile write throws. Signing in must not be collateral damage.
  it('still signs a user in when the profile write fails', async () => {
    const exploding: OpsUserProfileRepo = {
      upsert: async () => { throw new Error('relation "ops_user_profiles" does not exist'); },
      namesByEmail: async () => new Map(),
    };
    const app = createApp({ auth, adminApiKey: 'k', opsUserProfiles: exploding, googleVerifier: verifierFor('f@x.com', 'Sandra Wolker') });
    expect((await login(app)).status).toBe(200);
    expect((await app.request('/admin/ops/whoami', { headers: { cookie: await cookie('f@x.com', 'Sandra Wolker') } })).status).toBe(200);
  });
});

describe('GET /admin/ops/users — display names for the assign picker', () => {
  it('labels each user first-name + last-initial once their name is known', async () => {
    const opsUserProfiles = new InMemoryOpsUserProfileRepo();
    await opsUserProfiles.upsert('f@x.com', 'Sandra Wolker');
    const app = createApp({ auth, adminApiKey: 'k', opsUserProfiles });
    const res = await app.request('/admin/ops/users', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
    expect((await res.json()).users).toEqual([
      { email: 'f@x.com', role: 'founder', displayName: 'Sandra W.' },
      { email: 'op@x.com', role: 'ops', displayName: 'op' }, // never signed in → local part
    ]);
  });

  // Same missing-table window as above: the roster is how staff hand work over, so a failed
  // name lookup must cost us the names, not the picker.
  it('falls back to local parts when the profile read fails', async () => {
    const exploding: OpsUserProfileRepo = {
      upsert: async () => {},
      namesByEmail: async () => { throw new Error('relation "ops_user_profiles" does not exist'); },
    };
    const app = createApp({ auth, adminApiKey: 'k', opsUserProfiles: exploding });
    const res = await app.request('/admin/ops/users', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
    expect((await res.json()).users).toEqual([
      { email: 'f@x.com', role: 'founder', displayName: 'f' },
      { email: 'op@x.com', role: 'ops', displayName: 'op' },
    ]);
  });
});
