import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import {
  CUSTOMER_COOKIE,
  customerIdentity,
  requireCustomer,
  signCustomerSession,
  verifyCustomerSession,
  issueCustomerCookie,
  clearCustomerCookie,
  signRideMemberToken,
  verifyRideMemberToken,
  type CustomerSession,
} from './customerAuth';

// ============================================================================
// WHY this file exists: customerAuth is the Ride Board's ONLY customer-facing
// security boundary. The session cookie decides who a traveller is, and the
// ride-member capability token decides which list they may edit — i.e. it is
// what stops one traveller scratching another person's name off a shared ride.
// Both are unauthenticated input from the wire, so the properties that matter
// are the negative ones: a token minted under someone else's secret, a payload
// edited in flight, or a list id swapped for a different list must all be
// REJECTED, and pure garbage must return null instead of throwing (a throw in
// customerIdentity would 500 every board request, not just a bad one).
// ============================================================================

const S = 'test-secret';
const OTHER = 'other-secret';

const NOW = 1_700_000_000_000;

function session(over: Partial<CustomerSession> = {}): CustomerSession {
  return {
    sub: 'google-sub-1',
    email: 'traveller@example.com',
    name: 'Ada Traveller',
    country: 'LK',
    exp: NOW + 60_000,
    ...over,
  };
}

// Build a Cookie request header carrying a raw token, so middleware tests drive
// exactly the bytes an attacker would send.
function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${CUSTOMER_COOKIE}=${encodeURIComponent(token)}` };
}

function boardApp(secret = S) {
  const app = new Hono();
  app.use('*', customerIdentity(secret));
  app.get('/open', (c) => c.json({ who: c.get('customer')?.email ?? null }));
  app.get('/gated', requireCustomer(), (c) => c.json({ who: c.get('customer').email }));
  return app;
}

describe('customer session token', () => {
  it('round-trips the traveller identity', () => {
    const s = session({ photo: 'https://example.com/a.jpg' });
    expect(verifyCustomerSession(signCustomerSession(s, S), S, NOW)).toEqual(s);
  });

  it('drops an absent photo rather than inventing one', () => {
    const out = verifyCustomerSession(signCustomerSession(session(), S), S, NOW);
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('photo');
  });

  it('refuses a session signed with a different secret', () => {
    const t = signCustomerSession(session(), OTHER);
    expect(verifyCustomerSession(t, S, NOW)).toBeNull();
  });

  it('refuses a forged payload that keeps a genuine signature', () => {
    const t = signCustomerSession(session(), S);
    const sig = t.split('.')[1];
    const forged = Buffer.from(JSON.stringify(session({ sub: 'attacker', email: 'evil@x.com' }))).toString(
      'base64url',
    );
    expect(verifyCustomerSession(`${forged}.${sig}`, S, NOW)).toBeNull();
  });

  it('refuses a tampered signature', () => {
    const t = signCustomerSession(session(), S);
    const last = t.slice(-1);
    expect(verifyCustomerSession(t.slice(0, -1) + (last === '0' ? '1' : '0'), S, NOW)).toBeNull();
  });

  it('refuses an expired session at and after its exp', () => {
    const t = signCustomerSession(session({ exp: NOW }), S);
    expect(verifyCustomerSession(t, S, NOW)).toBeNull();
    expect(verifyCustomerSession(t, S, NOW + 1)).toBeNull();
    expect(verifyCustomerSession(t, S, NOW - 1)).not.toBeNull();
  });

  it('refuses a validly-signed payload missing required identity fields', () => {
    // Signed with the REAL secret — only the shape is wrong, so this can only be
    // caught by the field checks, not by the HMAC.
    const half = { sub: 'x', email: 'e@x.com', exp: NOW + 1000 }; // no name, no country
    const body = Buffer.from(JSON.stringify(half)).toString('base64url');
    const forged = signCustomerSession(half as unknown as CustomerSession, S);
    expect(forged.startsWith(body)).toBe(true); // same body, genuine mac
    expect(verifyCustomerSession(forged, S, NOW)).toBeNull();
  });

  it('refuses a validly-signed non-object payload', () => {
    const forged = signCustomerSession('not-a-session' as unknown as CustomerSession, S);
    expect(verifyCustomerSession(forged, S, NOW)).toBeNull();
  });

  it('returns null (never throws) for undefined, empty, dot-less and garbage input', () => {
    expect(verifyCustomerSession(undefined, S, NOW)).toBeNull();
    expect(verifyCustomerSession('', S, NOW)).toBeNull();
    expect(verifyCustomerSession('no-dot-here', S, NOW)).toBeNull();
    expect(verifyCustomerSession('....', S, NOW)).toBeNull();
    expect(verifyCustomerSession('.sig', S, NOW)).toBeNull();
    expect(verifyCustomerSession('body.', S, NOW)).toBeNull();
    expect(verifyCustomerSession('%%%.%%%', S, NOW)).toBeNull();
  });

  it('returns null when the body is valid base64url but not JSON', () => {
    // Genuine HMAC over a non-JSON body: gets past the signature check, so only
    // the try/catch around JSON.parse can save us here.
    const body = Buffer.from('definitely not json').toString('base64url');
    const sig = createHmac('sha256', S).update(body).digest('hex');
    expect(verifyCustomerSession(`${body}.${sig}`, S, NOW)).toBeNull();
  });
});

describe('customerIdentity middleware', () => {
  it('degrades to "no customer" when there is no cookie', async () => {
    const res = await boardApp().request('/open');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: null });
  });

  it('degrades to "no customer" for a garbage cookie instead of throwing', async () => {
    const res = await boardApp().request('/open', { headers: cookieHeader('!!!not-a-token!!!') });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: null });
  });

  it('degrades to "no customer" for a cookie signed with the wrong secret', async () => {
    const t = signCustomerSession(session(), OTHER);
    const res = await boardApp(S).request('/open', { headers: cookieHeader(t) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: null });
  });

  it('degrades to "no customer" for an expired cookie', async () => {
    const t = signCustomerSession(session({ exp: Date.now() - 1000 }), S);
    const res = await boardApp().request('/open', { headers: cookieHeader(t) });
    expect(await res.json()).toEqual({ who: null });
  });

  it('populates the traveller for a valid cookie', async () => {
    const t = signCustomerSession(session({ exp: Date.now() + 60_000 }), S);
    const res = await boardApp().request('/open', { headers: cookieHeader(t) });
    expect(await res.json()).toEqual({ who: 'traveller@example.com' });
  });

  it('ignores a staff-style cookie under a different name', async () => {
    const t = signCustomerSession(session({ exp: Date.now() + 60_000 }), S);
    const res = await boardApp().request('/open', { headers: { cookie: `ch_ops=${encodeURIComponent(t)}` } });
    expect(await res.json()).toEqual({ who: null });
  });
});

describe('requireCustomer gate', () => {
  it('401s with sign_in_required when unauthenticated', async () => {
    const res = await boardApp().request('/gated');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
  });

  it('401s rather than passing through on a wrong-secret cookie', async () => {
    const t = signCustomerSession(session({ exp: Date.now() + 60_000 }), OTHER);
    const res = await boardApp(S).request('/gated', { headers: cookieHeader(t) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
  });

  it('passes a signed-in traveller through to the handler', async () => {
    const t = signCustomerSession(session({ exp: Date.now() + 60_000 }), S);
    const res = await boardApp().request('/gated', { headers: cookieHeader(t) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: 'traveller@example.com' });
  });
});

describe('customer cookie issue/clear', () => {
  it('issues an httpOnly, Secure, SameSite=None cookie that verifies back', async () => {
    const app = new Hono();
    app.post('/login', (c) => {
      issueCustomerCookie(c, { sub: 's1', email: 'e@x.com', name: 'N', country: 'LK' }, S, NOW);
      return c.json({ ok: true });
    });
    const setCookie = (await app.request('/login', { method: 'POST' })).headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=None/i);

    const raw = decodeURIComponent(setCookie.split(';')[0].slice(`${CUSTOMER_COOKIE}=`.length));
    const s = verifyCustomerSession(raw, S, NOW);
    expect(s?.email).toBe('e@x.com');
    expect(s?.exp).toBeGreaterThan(NOW);
  });

  it('clears with an empty, immediately-expiring cookie', async () => {
    const app = new Hono();
    app.post('/logout', (c) => {
      clearCustomerCookie(c);
      return c.json({ ok: true });
    });
    const setCookie = (await app.request('/logout', { method: 'POST' })).headers.get('set-cookie')!;
    expect(setCookie).toContain(`${CUSTOMER_COOKIE}=;`);
    expect(setCookie).toMatch(/Max-Age=0/i);
  });
});

describe('ride-member capability token', () => {
  it('round-trips the list and the traveller it was minted for', () => {
    const t = signRideMemberToken('list-1', 'sub-1', S);
    expect(verifyRideMemberToken(t, S)).toEqual({ listId: 'list-1', sub: 'sub-1' });
  });

  it('refuses a token minted under a different secret', () => {
    const t = signRideMemberToken('list-1', 'sub-1', OTHER);
    expect(verifyRideMemberToken(t, S)).toBeNull();
  });

  it('does not authorise a different list — a token for X never verifies as X-prime', () => {
    const t = signRideMemberToken('list-X', 'sub-1', S);
    // The token can only ever speak for the list it was signed for.
    expect(verifyRideMemberToken(t, S)?.listId).toBe('list-X');
    // Swapping the list id in the payload while keeping the genuine signature fails.
    const sig = t.split('.')[1];
    const swapped = Buffer.from(JSON.stringify({ listId: 'list-Y', sub: 'sub-1' })).toString('base64url');
    expect(verifyRideMemberToken(`${swapped}.${sig}`, S)).toBeNull();
  });

  it('refuses a swapped sub — one traveller cannot scratch off another name', () => {
    const t = signRideMemberToken('list-1', 'victim-sub', S);
    const sig = t.split('.')[1];
    const swapped = Buffer.from(JSON.stringify({ listId: 'list-1', sub: 'attacker-sub' })).toString('base64url');
    expect(verifyRideMemberToken(`${swapped}.${sig}`, S)).toBeNull();
    // and re-signing under a guessed secret does not help either
    expect(verifyRideMemberToken(signRideMemberToken('list-1', 'attacker-sub', OTHER), S)).toBeNull();
  });

  it('refuses a tampered signature', () => {
    const t = signRideMemberToken('list-1', 'sub-1', S);
    const last = t.slice(-1);
    expect(verifyRideMemberToken(t.slice(0, -1) + (last === '0' ? '1' : '0'), S)).toBeNull();
  });

  it('refuses a validly-signed token with an empty or missing listId/sub', () => {
    expect(verifyRideMemberToken(signRideMemberToken('', 'sub-1', S), S)).toBeNull();
    expect(verifyRideMemberToken(signRideMemberToken('list-1', '', S), S)).toBeNull();
    const body = Buffer.from(JSON.stringify({ listId: 'list-1' })).toString('base64url');
    const genuine = signRideMemberToken('list-1', 'sub-1', S);
    expect(verifyRideMemberToken(`${body}.${genuine.split('.')[1]}`, S)).toBeNull();
  });

  it('refuses a booking-style token (different payload shape, same idiom)', () => {
    // bookingToken signs {id}; it must never be accepted as a ride-member grant.
    const body = Buffer.from(JSON.stringify({ id: 'booking-1' })).toString('base64url');
    const sig = createHmac('sha256', S).update(body).digest('hex');
    expect(verifyRideMemberToken(`${body}.${sig}`, S)).toBeNull();
  });

  it('returns null (never throws) for undefined, empty, dot-less and garbage input', () => {
    expect(verifyRideMemberToken(undefined, S)).toBeNull();
    expect(verifyRideMemberToken('', S)).toBeNull();
    expect(verifyRideMemberToken('no-dot-here', S)).toBeNull();
    expect(verifyRideMemberToken('....', S)).toBeNull();
    expect(verifyRideMemberToken('.sig', S)).toBeNull();
    expect(verifyRideMemberToken('body.', S)).toBeNull();
    expect(verifyRideMemberToken('%%%.%%%', S)).toBeNull();
  });

  it('returns null when the body is valid base64url but not JSON', () => {
    const body = Buffer.from('nope').toString('base64url');
    const sig = createHmac('sha256', S).update(body).digest('hex');
    expect(verifyRideMemberToken(`${body}.${sig}`, S)).toBeNull();
  });
});

// KNOWN BUG (documented, not fixed here). verifyRideMemberToken length-guards on
// `sig.length` (UTF-16 code units) but then handed raw Buffers to timingSafeEqual,
// which compares BYTE length. A 64-character signature containing any multi-byte
// character passed the guard and made timingSafeEqual throw a RangeError, so
// GET /…?t=<that token> 500'd instead of quietly rejecting a bad token — and,
// worse, filled Sentry with noise an attacker controls. FIXED 2026-07-26 by
// comparing Buffer lengths, matching the sibling verifyCustomerSession.
describe('ride-member capability token — malformed signature encoding', () => {
  it('returns null instead of throwing for a multi-byte signature of the right char length', () => {
    const genuine = signRideMemberToken('list-1', 'sub-1', S);
    const [body, sig] = genuine.split('.');
    // Same character count as a real hex mac (64), but 65 bytes once encoded.
    const multiByteSig = 'é' + sig.slice(1);
    expect(multiByteSig.length).toBe(sig.length);
    expect(verifyRideMemberToken(`${body}.${multiByteSig}`, S)).toBeNull();
  });
});
