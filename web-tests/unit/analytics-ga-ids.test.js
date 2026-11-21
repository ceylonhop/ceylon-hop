// The GA visitor + session this browser is, sent with checkout so the SERVER's purchase joins
// this visit (spec 2026-10-03 §5.2). Read from GA's own cookies; nothing may ever block a checkout.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '..', '..', 'analytics.js'), 'utf8');

// On booking.html, where checkout reads these ids — and where the cookie strip never opens,
// whatever the clock says.
function load(cookie, stored = null, timeZone = 'Asia/Colombo') {
  const win = {
    location: { hostname: 'ceylonhop.com', pathname: '/booking.html' },
    document: { addEventListener() {}, readyState: 'complete', cookie },
    localStorage: { getItem: (k) => (k === 'ceylonhop_cookie_choice' ? stored : null) },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) },
  };
  new Function('window', 'document', 'location', src)(win, win.document, win.location);
  return win;
}

describe('chGaIds', () => {
  it('reads the client id from _ga and the session id from a GS1 session cookie', () => {
    const w = load('_ga=GA1.1.123456789.1700000000; _ga_XEW62ZD7B3=GS1.1.1759400000.3.1.1759400100.0.0.0');
    expect(w.chGaIds()).toEqual({ clientId: '123456789.1700000000', sessionId: '1759400000', adConsent: 'unknown' });
  });
  it('reads the newer GS2 session cookie format', () => {
    const w = load('_ga=GA1.1.42.1700000000; _ga_XEW62ZD7B3=GS2.1.s1759400000$o3$g1$t1759400100$j0$l0$h0');
    expect(w.chGaIds().sessionId).toBe('1759400000');
  });
  it('passes on the stored ad-consent choice', () => {
    expect(load('', 'denied').chGaIds().adConsent).toBe('denied');
    expect(load('', 'granted').chGaIds().adConsent).toBe('granted');
  });
  // The head snippet denies ads by region (EEA/UK/CH) until the strip is answered, so the
  // server's purchase must not read silence there as a grant. It used to send 'unknown', and the
  // server fell back to the TYPED country: a London visitor who wrote "Sri Lanka" went out GRANTED.
  it('a European clock with no answer is denied, matching the head snippet', () => {
    expect(load('', null, 'Europe/London').chGaIds().adConsent).toBe('denied');
    expect(load('', null, 'Atlantic/Canary').chGaIds().adConsent).toBe('denied');
  });
  it('an explicit answer still wins on a European clock', () => {
    expect(load('', 'granted', 'Europe/Berlin').chGaIds().adConsent).toBe('granted');
  });
  it('elsewhere, or with no clock to read, silence stays unknown for the server to judge', () => {
    expect(load('', null, 'Asia/Colombo').chGaIds().adConsent).toBe('unknown');
    expect(load('', null, 'America/New_York').chGaIds().adConsent).toBe('unknown');
    expect(load('', null, undefined).chGaIds().adConsent).toBe('unknown');
  });
  it('no GA cookies (blocked, or first paint) → nulls, and checkout bodies stay unchanged', () => {
    const w = load('other=1');
    expect(w.chGaIds()).toEqual({ clientId: null, sessionId: null, adConsent: 'unknown' });
    expect(w.chWithGa({ returnTo: 'manage' })).toEqual({ returnTo: 'manage' });
  });
  it('adds ga to a checkout body only when there is an id to send', () => {
    const w = load('_ga=GA1.1.1.2');
    expect(w.chWithGa({ returnTo: 'pay-link' })).toEqual({ returnTo: 'pay-link', ga: { clientId: '1.2', sessionId: null, adConsent: 'unknown' } });
  });
});
