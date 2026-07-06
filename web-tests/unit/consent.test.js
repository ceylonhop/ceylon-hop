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
function run(win){ new Function('window','document','localStorage', src)(win, win.document, win.localStorage); }

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
});
