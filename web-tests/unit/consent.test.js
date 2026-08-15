import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const src = readFileSync(join(__dirname, '..', '..', 'consent.js'), 'utf8');

function makeDom() {
  const store = {};
  const body = { _html: '', insertAdjacentHTML(_, h){ this._html += h; }, querySelector(){ return null; } };
  const listeners = {};
  return {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k,v)=>{store[k]=String(v);} },
    calls: [],
    gtag: function(){ /* set below */ },
    document: {
      body,
      readyState: 'complete',
      addEventListener(ev,cb){ (listeners[ev]=listeners[ev]||[]).push(cb); },
      // minimal element factory for the banner buttons
      getElementById: () => null,
    },
    _store: store,
  };
}
function run(win, source){ new Function('window','document','localStorage', source || src)(win, win.document, win.localStorage); }

// `withBanner` flips the owner switch for the tests that exercise the banner itself, the same
// way consent-transactional.test.js flips ASK_FIRST — one source of truth, no second copy.
function withBanner(source) {
  const flipped = source.replace('var SHOW_BANNER = false;', 'var SHOW_BANNER = true;');
  if (flipped === source) throw new Error('SHOW_BANNER switch not found — has it been renamed?');
  return flipped;
}

describe('consent banner', () => {
  let win;
  beforeEach(() => {
    win = makeDom();
    win.gtag = vi.fn();
    win.location = { hostname: 'ceylonhop.com' };
  });

  it('with no prior choice, defaults stay denied (no consent update on load)', () => {
    run(win);
    expect(win.gtag).not.toHaveBeenCalledWith('consent', 'update', expect.anything());
  });

  it('with a stored grant, replays granted on load and does not render the banner', () => {
    win._store['ceylonhop_consent'] = 'granted';
    run(win);
    expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ analytics_storage: 'granted' }));
    expect(win.document.body._html).toBe(''); // banner not injected
  });

  it('exposes chConsent(choice) that stores and updates', () => {
    run(win);
    win.chConsent('granted');
    expect(win._store['ceylonhop_consent']).toBe('granted');
    expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ ad_storage: 'granted' }));
  });

  // Owner call 2026-08-15: no cookie banner on the site just yet. The switch keeps the banner
  // code alive (and tested below) so bringing it back is a one-word change, not a rebuild.
  describe('the owner switch (banner off)', () => {
    it('ships as SHOW_BANNER = false — owner call 2026-08-15, revisit before launch', () => {
      expect(src).toMatch(/var SHOW_BANNER = false;/);
      expect(src.match(/SHOW_BANNER\s*=/g)).toHaveLength(1);
    });

    it('with the switch off, no banner is injected even with no prior choice', () => {
      run(win);
      expect(win.document.body._html).toBe('');
    });

    it('still replays a stored grant with the switch off', () => {
      win._store['ceylonhop_consent'] = 'granted';
      run(win);
      expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ analytics_storage: 'granted' }));
    });
  });

  describe('the banner, kept alive for the day the switch flips', () => {
    it('renders with SHOW_BANNER = true and no prior choice', () => {
      run(win, withBanner(src));
      expect(win.document.body._html).toContain('ch-consent');
    });

    it('still respects a stored refusal — no banner, no grant', () => {
      win._store['ceylonhop_consent'] = 'denied';
      run(win, withBanner(src));
      expect(win.document.body._html).toBe('');
      expect(win.gtag).not.toHaveBeenCalledWith('consent', 'update', expect.anything());
    });
  });
});
