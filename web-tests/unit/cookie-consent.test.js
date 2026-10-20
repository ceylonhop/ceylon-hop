// The Europe-only cookie strip (owner decision 2026-09-27).
//
// WHY it exists: since Clarity's Oct-2025 enforcement, a visitor from the EEA / UK / CH with no
// consent signal is recorded cookieless — a new user and a new session on EVERY page view. With
// ad_storage denied there by default (#677) and no banner (#561), nothing could ever grant it, so
// Clarity showed UK: 162 sessions = 162 users at 1.04 pages/session (25–27 Sep 2026) while Sri
// Lanka showed 64 sessions / 29 users at 3.91. One UK visitor on 27 Sep became 25 "users".
//
// Three pieces, tested here:
//   1. the head snippet REPLAYS a stored choice before GTM loads (site-chrome.mjs),
//   2. analytics.js decides whether to ASK (European timezone, not a checkout page) and wires
//      the footer's "Cookie choices" link,
//   3. consent.js draws the strip and records the answer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyticsSnippet, renderFooter } from '../../tools/site-chrome.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const KEY = 'ceylonhop_cookie_choice';

// consent commands are pushed as `arguments` objects, exactly as gtag() does.
const consentCalls = (kind) =>
  (window.dataLayer || [])
    .map((e) => Array.from(e && e.length !== undefined ? e : []))
    .filter((a) => a[0] === 'consent' && a[1] === kind)
    .map((a) => a[2]);

describe('head snippet replays a stored choice before GTM loads', () => {
  // Execute the SHIPPED bytes of the first <script>, not a copy of the logic.
  const headScript = analyticsSnippet.match(/<script>([\s\S]*?)<\/script>/)[1];
  const run = () => new Function(headScript)();

  beforeEach(() => { window.dataLayer = []; localStorage.clear(); });

  it('an earlier Accept grants the three advertising signals on every later page', () => {
    localStorage.setItem(KEY, 'granted');
    run();
    const [update] = consentCalls('update');
    expect(update).toEqual({ ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' });
  });

  it('an earlier Reject denies them (an opt-out outside Europe, a no-op inside)', () => {
    localStorage.setItem(KEY, 'denied');
    run();
    expect(consentCalls('update')).toEqual([
      { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' },
    ]);
  });

  it('no stored choice → no update: the defaults stand exactly as before', () => {
    run();
    expect(consentCalls('update')).toHaveLength(0);
  });

  it('a junk stored value is ignored rather than passed to Consent Mode', () => {
    localStorage.setItem(KEY, 'yes please');
    run();
    expect(consentCalls('update')).toHaveLength(0);
  });

  it('never touches analytics_storage — that stays granted by the default', () => {
    localStorage.setItem(KEY, 'denied');
    run();
    expect(consentCalls('update')[0].analytics_storage).toBeUndefined();
  });

  it('a storage that throws (private mode, blocked site data) does not break the page', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect(run).not.toThrow();
      expect(consentCalls('update')).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it('the replay sits between the defaults and the GTM loader', () => {
    const iReplay = analyticsSnippet.indexOf(KEY);
    expect(iReplay).toBeGreaterThan(analyticsSnippet.indexOf('region:'));
    expect(iReplay).toBeLessThan(analyticsSnippet.indexOf('googletagmanager.com'));
  });
});

describe('analytics.js: who gets asked', () => {
  const src = read('analytics.js');
  const load = (win) => { new Function('window', 'location', src)(win, win.location); return win; };
  const ask = (tz, path = '/') => load({ location: { hostname: 'ceylonhop.com', pathname: '/' } }).chConsentAsk(tz, path);

  it.each(['Europe/London', 'Europe/Berlin', 'Europe/Dublin', 'Europe/Zurich', 'Europe/Oslo',
    'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Reykjavik'])('asks in %s', (tz) => {
    expect(ask(tz)).toBe(true);
  });

  // A UK traveller already in Sri Lanka has a Colombo clock: Google's IP-based region is Sri
  // Lanka too, so advertising is already granted there and there is nothing to ask.
  it.each(['Asia/Colombo', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata', 'UTC', 'Etc/UTC', '',
    'Atlantic/Bermuda', 'Atlantic/South_Georgia'])('does not ask in %s', (tz) => {
    expect(ask(tz)).toBe(false);
  });

  // Owner call: nothing competes with the price sheet or Pay.
  it.each(['/booking.html', '/manage.html', '/pay.html', '/quote.html', '/p', '/q', '/ops', '/ops/quotes'])(
    'never auto-asks on %s', (path) => {
      expect(ask('Europe/London', path)).toBe(false);
    });

  it.each(['/', '/index.html', '/search.html', '/plan.html', '/board.html', '/trip/', '/trip/kandy-to-ella/'])(
    'asks on the browsing page %s', (path) => {
      expect(ask('Europe/London', path)).toBe(true);
    });

  it('existing fake-window callers without Intl or storage still load cleanly', () => {
    expect(() => load({ location: { hostname: 'ceylonhop.com' } })).not.toThrow();
  });
});

describe('analytics.js: loading the strip', () => {
  const src = read('analytics.js');
  const tzWin = (timeZone, pathname = '/', stored = null) => ({
    location: { hostname: 'ceylonhop.com', pathname },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) },
    localStorage: { getItem: () => stored, setItem() {} },
  });
  const load = (win) => { new Function('window', 'location', src)(win, win.location); return win; };
  const strips = () => document.querySelectorAll('script[data-ch-consent]');

  afterEach(() => { strips().forEach((s) => s.remove()); });

  it('loads consent.js for a European visitor with no answer yet', () => {
    load(tzWin('Europe/London'));
    expect(strips()).toHaveLength(1);
    expect(strips()[0].src).toMatch(/consent\.js$/);
  });

  it('does not load it for a visitor who already answered', () => {
    load(tzWin('Europe/London', '/', 'denied'));
    expect(strips()).toHaveLength(0);
  });

  it('does not load it outside Europe', () => {
    load(tzWin('Asia/Colombo'));
    expect(strips()).toHaveLength(0);
  });

  it('does not load it on the booking page', () => {
    load(tzWin('Europe/London', '/booking.html'));
    expect(strips()).toHaveLength(0);
  });

  it('the footer link opens it for anyone, anywhere, on demand', () => {
    const win = load(tzWin('Asia/Colombo'));
    expect(strips()).toHaveLength(0);
    win.chConsentOpen();
    expect(strips()).toHaveLength(1);
    win.chConsentOpen();                      // a second press re-shows, never double-loads
    expect(strips()).toHaveLength(1);
  });
});

describe('consent.js: the strip', () => {
  const load = () => new Function('window', 'document', read('consent.js'))(window, document);
  const strip = () => document.getElementById('ch-consent');
  const press = (choice) => strip().querySelector(`[data-consent="${choice}"]`).click();

  beforeEach(() => {
    window.dataLayer = [];
    localStorage.clear();
    window.chTrack = vi.fn();
    window.clarity = vi.fn();
    document.body.innerHTML = '<a class="wa-fab" href="https://wa.me/94779669662">WhatsApp</a>';
    document.documentElement.className = '';
    load();
  });
  afterEach(() => { delete window.chConsentShow; delete window.chTrack; delete window.clarity; });

  it('renders one labelled strip with Reject and Accept and a privacy link', () => {
    expect(strip()).toBeTruthy();
    expect(strip().getAttribute('role')).toBe('region');
    expect(strip().getAttribute('aria-label')).toMatch(/cookie/i);
    expect(strip().textContent).toContain('measure our ads and see how visits flow through the site');
    expect(strip().querySelector('a[href="/privacy.html#cookies"]')).toBeTruthy();
    expect(strip().querySelector('[data-consent="denied"]').textContent.trim()).toBe('Reject');
    expect(strip().querySelector('[data-consent="granted"]').textContent.trim()).toBe('Accept');
  });

  // UK/EU guidance: refusing must be as easy as accepting. Same element, same class, same size.
  it('gives Reject and Accept equal prominence', () => {
    const [r, a] = [...strip().querySelectorAll('button')];
    expect(r.className).toBe(a.className);
    expect(r.getAttribute('style')).toBe(a.getAttribute('style'));
  });

  it('flags <html> while open so fixed bottom controls can move clear of it', () => {
    expect(document.documentElement.classList.contains('ch-consent-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--ch-consent-h')).toMatch(/^\d+px$/);
  });

  it('Accept: remembers, grants advertising, tells Clarity, records the choice, and goes away', () => {
    press('granted');
    expect(localStorage.getItem(KEY)).toBe('granted');
    expect(consentCalls('update')).toEqual([
      { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
    ]);
    expect(window.clarity).toHaveBeenCalledWith('consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' });
    expect(window.chTrack).toHaveBeenCalledWith('consent_choice', { choice: 'granted' });
    expect(strip()).toBeNull();
    expect(document.documentElement.classList.contains('ch-consent-open')).toBe(false);
  });

  it('Reject: remembers, keeps advertising denied, analytics untouched, and goes away', () => {
    press('denied');
    expect(localStorage.getItem(KEY)).toBe('denied');
    const [update] = consentCalls('update');
    expect(update).toEqual({ ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    expect(window.clarity).toHaveBeenCalledWith('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
    expect(window.chTrack).toHaveBeenCalledWith('consent_choice', { choice: 'denied' });
    expect(strip()).toBeNull();
  });

  it('works before Clarity or the analytics helper have loaded', () => {
    delete window.clarity; delete window.chTrack;
    expect(() => press('granted')).not.toThrow();
    expect(localStorage.getItem(KEY)).toBe('granted');
  });

  it('chConsentShow re-opens it after an answer, and never stacks two', () => {
    press('denied');
    window.chConsentShow();
    window.chConsentShow();
    expect(document.querySelectorAll('#ch-consent')).toHaveLength(1);
  });
});

describe('footer: "Cookie choices" on every page', () => {
  const LINK = /<a href="([^"]*)privacy\.html#cookies" data-consent-open>Cookie choices<\/a>/;

  it('the baked footer carries it, with a no-JS fallback to the privacy page', () => {
    expect(renderFooter('../../')).toMatch(LINK);
    expect(renderFooter('../../').match(LINK)[1]).toBe('../../');
  });

  it('site.js renders the same link at runtime (static/runtime parity)', () => {
    expect(read('site.js')).toMatch(LINK);
  });
});

// The policy wording itself is pinned in analytics-snippet.test.js ('privacy disclosure').
describe('privacy policy anchor', () => {
  const src = () => read('tools/legal/privacy.body.html');

  it('gives the cookie paragraph an anchor the strip and footer link to', () => {
    expect(src()).toMatch(/<li id="cookies">/);
  });
});
