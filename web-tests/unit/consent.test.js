import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const src = readFileSync(join(__dirname, '..', '..', 'consent.js'), 'utf8');

function makeDom(opts) {
  const store = {};
  const body = { _html: '', insertAdjacentHTML(_, h){ this._html += h; }, querySelector(){ return null; } };
  const listeners = {};
  // The beta postcard, if this fixture is pretending one is on screen. `closeBetaNotice()`
  // removes it and fires the observer, the way beta-notice.js's dismiss() does.
  const state = { beta: !!(opts && opts.betaNotice), observers: [] };
  const win = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k,v)=>{store[k]=String(v);} },
    calls: [],
    gtag: function(){ /* set below */ },
    MutationObserver: function (cb) {
      this.observe = () => { state.observers.push(cb); };
      this.disconnect = () => { state.observers = state.observers.filter(o => o !== cb); };
    },
    addEventListener(ev, cb){ (listeners[ev]=listeners[ev]||[]).push(cb); },
    document: {
      body,
      readyState: 'complete',
      addEventListener(ev,cb){ (listeners[ev]=listeners[ev]||[]).push(cb); },
      // minimal element factory for the banner buttons
      getElementById: () => null,
      querySelector: (sel) => (sel === '.ch-beta' && state.beta ? { tagName: 'DIV' } : null),
    },
    _store: store,
    _state: state,
    closeBetaNotice(){ state.beta = false; state.observers.slice().forEach(cb => cb()); },
  };
  return win;
}
function run(win, source){ new Function('window','document','localStorage', source || src)(win, win.document, win.localStorage); }
// render() is now deferred a macrotask so beta-notice.js has run before we look for its
// markup (see consent.js) — assertions about the banner must wait for that tick.
const flush = () => new Promise((r) => setTimeout(r, 0));

// The banner SHIPS ON now (2026-08-16), so the switch-forced helper flips the other way:
// these keep the off-path tested rather than letting it rot, the same way
// consent-transactional.test.js keeps its dormant ASK_FIRST path alive.
function withoutBanner(source) {
  const flipped = source.replace('var SHOW_BANNER = true;', 'var SHOW_BANNER = false;');
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

  it('with a stored grant, replays granted on load and does not render the banner', async () => {
    win._store['ceylonhop_consent'] = 'granted';
    run(win);
    await flush();
    expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ analytics_storage: 'granted' }));
    expect(win.document.body._html).toBe(''); // banner not injected
  });

  it('exposes chConsent(choice) that stores and updates', () => {
    run(win);
    win.chConsent('granted');
    expect(win._store['ceylonhop_consent']).toBe('granted');
    expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ ad_storage: 'granted' }));
  });

  /* Switched back ON 2026-08-16. It was off since 2026-08-15 because it stacked on the beta
     notice — but with Consent Mode defaulting to denied and no way to grant, every GA4 hit
     carried gcs=G100 (a cookieless ping that never becomes a user) and prod.ceylonhop.com
     reported zero visitors while every other signal looked healthy. Off is not a neutral
     setting; it is "collect nothing, for ever". */
  describe('the owner switch (banner on)', () => {
    it('ships as SHOW_BANNER = true — off means Consent Mode stays denied for ever', () => {
      expect(src).toMatch(/var SHOW_BANNER = true;/);
      expect(src.match(/SHOW_BANNER\s*=/g)).toHaveLength(1);
    });

    it('renders the banner with no prior choice', async () => {
      run(win);
      await flush();
      expect(win.document.body._html).toContain('ch-consent');
    });

    it('still respects a stored refusal — no banner, no grant', async () => {
      win._store['ceylonhop_consent'] = 'denied';
      run(win);
      await flush();
      expect(win.document.body._html).toBe('');
      expect(win.gtag).not.toHaveBeenCalledWith('consent', 'update', expect.anything());
    });
  });

  describe('the off path, kept alive for the day the switch flips back', () => {
    it('with the switch off, no banner is injected even with no prior choice', async () => {
      run(win, withoutBanner(src));
      await flush();
      expect(win.document.body._html).toBe('');
    });

    it('still replays a stored grant with the switch off', async () => {
      win._store['ceylonhop_consent'] = 'granted';
      run(win, withoutBanner(src));
      await flush();
      expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ analytics_storage: 'granted' }));
    });
  });

  /* The reason it was switched off in the first place: greeting an arrival and asking about
     cookies in the same moment. Both scripts are deferred and consent.js is first in document
     order, so at execution time the postcard does not exist yet — the wait is what makes the
     check meaningful. */
  describe('waits for the beta notice before asking', () => {
    it('holds the banner while the postcard is on screen', async () => {
      const w = makeDom({ betaNotice: true });
      w.gtag = vi.fn();
      run(w);
      await flush();
      expect(w.document.body._html).toBe('');
    });

    it('asks as soon as the customer closes the postcard', async () => {
      const w = makeDom({ betaNotice: true });
      w.gtag = vi.fn();
      run(w);
      await flush();
      w.closeBetaNotice();
      expect(w.document.body._html).toContain('ch-consent');
    });

    it('asks straight away when no postcard is showing', async () => {
      const w = makeDom({ betaNotice: false });
      w.gtag = vi.fn();
      run(w);
      await flush();
      expect(w.document.body._html).toContain('ch-consent');
    });

    it('fails open — asks anyway if MutationObserver is missing', async () => {
      const w = makeDom({ betaNotice: true });
      w.gtag = vi.fn();
      w.MutationObserver = undefined;
      run(w);
      await flush();
      expect(w.document.body._html).toContain('ch-consent');
    });
  });
});
