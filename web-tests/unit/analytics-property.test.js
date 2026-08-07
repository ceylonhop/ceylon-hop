// The property/environment layer of analytics.js. Phase 0 instrumented one website;
// five customer-facing properties have shipped since, all pushing into the SAME GTM
// container. Without these, every hit is an anonymous hit on GTM-NL6K22CM and nothing
// downstream can tell a payment page from a blog post.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const src = readFileSync(path.join(ROOT, 'analytics.js'), 'utf8');

function fakeDoc() {
  return { addEventListener() {}, readyState: 'complete' };
}

// analytics.js is a browser IIFE; eval it against a fake window per test so each case
// gets a clean hostname/pathname without a jsdom navigation.
function loadInto(win) {
  const fn = new Function('window', 'document', 'location', src);
  fn(win, win.document || fakeDoc(), win.location);
  return win;
}

function at(hostname, pathname = '/', extra = {}) {
  const win = { location: { hostname, pathname }, document: fakeDoc(), ...extra };
  return loadInto(win);
}

describe('chProperty', () => {
  it('honours the property a page declares about itself', () => {
    // The declaration is the primary source: pay.html is reachable at pay.ceylonhop.com
    // AND directly on the API host, and both must report as `pay`.
    expect(at('pay.ceylonhop.com', '/p', { CH_PROPERTY: 'pay' }).chProperty()).toBe('pay');
    expect(at('ceylon-hop-api.onrender.com', '/pay.html', { CH_PROPERTY: 'pay' }).chProperty()).toBe('pay');
  });

  it('ignores a declaration that is not a known property', () => {
    // A typo must not mint a new dimension value that quietly splits every report.
    expect(at('ceylonhop.com', '/', { CH_PROPERTY: 'paybutnotreally' }).chProperty()).toBe('site');
  });

  it('falls back to the path, including the short link aliases', () => {
    expect(at('pay.ceylonhop.com', '/p').chProperty()).toBe('pay');
    expect(at('pay.ceylonhop.com', '/pay.html').chProperty()).toBe('pay');
    expect(at('quote.ceylonhop.com', '/q').chProperty()).toBe('quote');
    expect(at('quote.ceylonhop.com', '/quote.html').chProperty()).toBe('quote');
    expect(at('ceylonhop.com', '/manage.html').chProperty()).toBe('manage');
    expect(at('ride.ceylonhop.com', '/board.html').chProperty()).toBe('board');
  });

  it('treats the marketing site as the default', () => {
    expect(at('ceylonhop.com', '/').chProperty()).toBe('site');
    expect(at('ceylonhop.com', '/trip/colombo-to-kandy/').chProperty()).toBe('site');
    expect(at('ceylonhop.com', '/booking.html').chProperty()).toBe('site');
  });
});

describe('chEnv', () => {
  it('labels the production hosts', () => {
    expect(at('ceylonhop.com').chEnv()).toBe('prod');
    expect(at('pay.ceylonhop.com').chEnv()).toBe('prod');
    expect(at('quote.ceylonhop.com').chEnv()).toBe('prod');
    expect(at('ride.ceylonhop.com').chEnv()).toBe('prod');
    expect(at('ops.ceylonhop.com').chEnv()).toBe('prod');
    // The prod API serves the customer pages directly — see customerPages.ts.
    expect(at('ceylon-hop-api.onrender.com').chEnv()).toBe('prod');
  });

  it('labels staging as staging, whichever way the host spells it', () => {
    expect(at('ops.staging.ceylonhop.com').chEnv()).toBe('staging');
    expect(at('pay-staging.ceylonhop.com').chEnv()).toBe('staging');
    expect(at('staging.ceylonhop.com').chEnv()).toBe('staging');
    expect(at('ceylon-hop-staging.onrender.com').chEnv()).toBe('staging');
  });

  it('labels everything else dev', () => {
    expect(at('localhost').chEnv()).toBe('dev');
    expect(at('127.0.0.1').chEnv()).toBe('dev');
    expect(at('ceylonhop.github.io').chEnv()).toBe('dev');
    expect(at('prod.ceylonhop.com.evil.example').chEnv()).toBe('dev');
  });
});

describe('chIsProd — the revenue gate', () => {
  const isProd = (h) => at(h).chIsProd();

  it('true on the hosts where a real charge can actually happen', () => {
    expect(isProd('ceylonhop.com')).toBe(true);
    expect(isProd('www.ceylonhop.com')).toBe(true);
    // pay./quote./ride. are the SOLE live home of those flows — there is no other host a
    // customer reaches them on. Real USD has settled through pay.ceylonhop.com since
    // 2026-08-02 (docs/checkout-redirect-spec.md §2.1: the apex registration covers the
    // subdomain, and it is proven in production), so a purchase there is real revenue.
    expect(isProd('pay.ceylonhop.com')).toBe(true);
    expect(isProd('quote.ceylonhop.com')).toBe(true);
    expect(isProd('ride.ceylonhop.com')).toBe(true);
  });

  it('still false on prod.ceylonhop.com — deliberately, do not "fix" this', () => {
    // Unchanged from the original rule and for the original reason. prod.* is the
    // pre-cutover COPY of the marketing site, which is where the owner does test
    // bookings; pay./quote./ride. above are the live originals. Reporting prod.* would
    // put sandbox transactions into revenue permanently, and GA4 cannot delete events
    // after the fact. At the apex cutover the site moves to ceylonhop.com and matches
    // on its own, with no code change.
    expect(isProd('prod.ceylonhop.com')).toBe(false);
  });

  it('false on internal tooling, staging, Pages and localhost', () => {
    expect(isProd('ops.ceylonhop.com')).toBe(false);
    expect(isProd('ops.staging.ceylonhop.com')).toBe(false);
    expect(isProd('pay.staging.ceylonhop.com')).toBe(false);
    expect(isProd('pay-staging.ceylonhop.com')).toBe(false);
    expect(isProd('ceylon-hop-api.onrender.com')).toBe(false);
    expect(isProd('ceylonhop.github.io')).toBe(false);
    expect(isProd('localhost')).toBe(false);
    expect(isProd('127.0.0.1')).toBe(false);
  });

  it('false on lookalike hosts that merely contain our domain', () => {
    expect(isProd('prod.ceylonhop.com.evil.example')).toBe(false);
    expect(isProd('pay.ceylonhop.com.evil.example')).toBe(false);
    expect(isProd('notceylonhop.com')).toBe(false);
    expect(isProd('evil-prod.ceylonhop.com')).toBe(false);
  });
});

describe('ch_context', () => {
  it('is the first thing on the dataLayer, so every later tag can read it', () => {
    // GTM Data Layer Variables retain the last value pushed, so publishing the pair ONCE
    // up front lets every event tag segment by property without every call site — or
    // every tag — having to repeat it.
    const win = at('pay.ceylonhop.com', '/p', { CH_PROPERTY: 'pay' });
    expect(win.dataLayer[0]).toEqual({ event: 'ch_context', ch_property: 'pay', ch_env: 'prod' });
  });

  it('reports the marketing site correctly too', () => {
    const win = at('ceylonhop.com', '/index.html');
    expect(win.dataLayer[0]).toEqual({ event: 'ch_context', ch_property: 'site', ch_env: 'prod' });
  });

  it('does not clobber a dataLayer that GTM already created', () => {
    const win = { location: { hostname: 'ceylonhop.com', pathname: '/' }, document: fakeDoc(), dataLayer: [{ event: 'gtm.js' }] };
    loadInto(win);
    expect(win.dataLayer[0]).toEqual({ event: 'gtm.js' });
    expect(win.dataLayer[1].event).toBe('ch_context');
  });
});

describe('Clarity property tag', () => {
  it('tags the session with its property so replays are filterable', () => {
    const calls = [];
    const win = at('pay.ceylonhop.com', '/p', {
      CH_PROPERTY: 'pay',
      clarity: (...args) => calls.push(args),
    });
    expect(win.dataLayer[0].ch_property).toBe('pay');
    expect(calls).toContainEqual(['set', 'property', 'pay']);
    expect(calls).toContainEqual(['set', 'env', 'prod']);
  });

  it('survives Clarity not being there — it loads async via GTM, or not at all', () => {
    expect(() => at('pay.ceylonhop.com', '/p', { CH_PROPERTY: 'pay' })).not.toThrow();
  });

  it('retries, because GTM injects Clarity after this script runs', () => {
    const timers = [];
    const win = at('pay.ceylonhop.com', '/p', {
      CH_PROPERTY: 'pay',
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    });
    expect(timers.length).toBeGreaterThan(0);
    const calls = [];
    win.clarity = (...args) => calls.push(args);
    timers[0].fn();
    expect(calls).toContainEqual(['set', 'property', 'pay']);
  });
});
