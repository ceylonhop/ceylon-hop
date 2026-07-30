import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const src = readFileSync(path.join(ROOT, 'analytics.js'), 'utf8');

// analytics.js is a tiny browser IIFE; eval it against a fake window per test.
function loadInto(win) {
  const fn = new Function('window', 'location', src);
  fn(win, win.location);
  return win;
}

describe('chTrack', () => {
  let win;
  beforeEach(() => { win = { location: { hostname: 'ceylonhop.com' } }; loadInto(win); });

  it('creates dataLayer and pushes {event, ...params}', () => {
    win.chTrack('purchase', { value: 42, currency: 'USD' });
    expect(win.dataLayer).toEqual([{ event: 'purchase', value: 42, currency: 'USD' }]);
  });

  it('works with no params', () => {
    win.chTrack('begin_checkout');
    expect(win.dataLayer[0]).toEqual({ event: 'begin_checkout' });
  });

  it('never throws even if dataLayer.push is hostile', () => {
    win.dataLayer = { push() { throw new Error('boom'); } };
    expect(() => win.chTrack('x')).not.toThrow();
  });
});

describe('chIsProd', () => {
  const at = (hostname) => { const w = { location: { hostname } }; loadInto(w); return w.chIsProd(); };
  it('true on apex and www', () => {
    expect(at('ceylonhop.com')).toBe(true);
    expect(at('www.ceylonhop.com')).toBe(true);
  });
  it('false on prod.ceylonhop.com — deliberately, do not "fix" this', () => {
    // prod.* is where the app is served TODAY, so this looks like a bug: the
    // funnel has no `purchase` step. It isn't one. PayHere is apex-only (no
    // subdomains — docs/go-live-checklist.md §2), so a real payment CANNOT
    // happen on prod.*; anything completing there is sandbox. Widening this to
    // prod.* would only ever report test transactions as revenue, and GA4
    // cannot retroactively delete them.
    //
    // At the apex cutover the site moves to ceylonhop.com and the rule above
    // starts matching on its own. No code change is needed then.
    expect(at('prod.ceylonhop.com')).toBe(false);
  });

  it('false on Pages / localhost / previews', () => {
    expect(at('ceylonhop.github.io')).toBe(false);
    expect(at('localhost')).toBe(false);
    expect(at('127.0.0.1')).toBe(false);
    expect(at('staging.ceylonhop.com')).toBe(false);
  });

  it('false on staging and ops, which must never pollute revenue reporting', () => {
    expect(at('ops.ceylonhop.com')).toBe(false);
    expect(at('ops.staging.ceylonhop.com')).toBe(false);
    expect(at('prod.staging.ceylonhop.com')).toBe(false);
  });

  it('false on lookalike hosts that merely end in our domain', () => {
    expect(at('prod.ceylonhop.com.evil.example')).toBe(false);
    expect(at('notceylonhop.com')).toBe(false);
    expect(at('evil-prod.ceylonhop.com')).toBe(false);
  });
});
