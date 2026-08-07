// consent-transactional.js — the consent path for pay.html and quote.html.
//
// Why a second consent module exists at all: both pages set Consent Mode v2 to `denied`
// and then deliberately omit consent.js, because the floating banner overlaid the pay
// CTA (owner, 2026-08-01 / 2026-08-06). The banner went, but so did every grant — so
// `analytics_storage` stayed denied for the whole session, Clarity's tag never fired,
// and we have no replay of anybody paying. This module honours the owner's objection
// (nothing may cover the CTA) without honouring its side effect (no measurement).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SRC = readFileSync(path.join(ROOT, 'consent-transactional.js'), 'utf8');

function run({ search = '', stored = null, src = SRC, throwOnStorage = false } = {}) {
  document.body.innerHTML = '<main id="app"><button class="pp-cta">Pay with PayHere</button></main>';
  document.body.style.paddingBottom = '';
  const pushes = [];
  const win = {
    location: { hostname: 'pay.ceylonhop.com', pathname: '/p', search, href: 'https://pay.ceylonhop.com/p' + search },
    dataLayer: { push: (...a) => pushes.push(a) },
    document,
    setTimeout: (fn) => fn(),
    getComputedStyle: () => ({ height: '52px' }),
  };
  const storage = {
    getItem: () => { if (throwOnStorage) throw new Error('blocked'); return stored; },
    setItem: (k, v) => { if (throwOnStorage) throw new Error('blocked'); storage.last = [k, v]; },
  };
  // The IIFE closes over `window.localStorage`, so it has to hang off the fake window.
  win.localStorage = storage;
  const fn = new Function('window', 'document', src);
  fn(win, document);
  return { win, pushes, storage };
}

// The consent signal reaches gtag as dataLayer.push(arguments) — an arguments object.
const grants = (pushes) =>
  pushes
    .map((p) => Array.from(p[0] || []))
    .filter((a) => a[0] === 'consent' && a[1] === 'update')
    .map((a) => a[2]);

const bar = () => document.querySelector('.ch-tconsent');

describe('the ask', () => {
  it('renders a strip and grants nothing until it is answered', () => {
    const { pushes } = run();
    expect(bar()).not.toBeNull();
    expect(grants(pushes)).toEqual([]);
  });

  it('reserves its own space instead of floating over the CTA', () => {
    // This is the whole reason the module exists. The old banner was position:fixed with
    // nothing reserving room for it, so on a phone it sat squarely on "Pay with PayHere".
    run();
    expect(document.body.style.paddingBottom).toMatch(/\d+px/);
    expect(parseInt(document.body.style.paddingBottom, 10)).toBeGreaterThan(0);
  });

  it('clears the reserved space again once answered, leaving no gap behind', () => {
    run();
    document.querySelector('.ch-tconsent [data-consent="granted"]').click();
    expect(bar()).toBeNull();
    expect(document.body.style.paddingBottom).toBe('');
  });
});

describe('what Accept actually grants', () => {
  it('grants analytics storage', () => {
    const { pushes } = run();
    document.querySelector('.ch-tconsent [data-consent="granted"]').click();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });

  it('NEVER grants advertising, on these pages, ever', () => {
    // A payer is not an ad audience. Keeping ad_storage denied here also keeps the pay
    // and quote pages out of remarketing entirely, which is the posture we want on a
    // page that exists only because someone already decided to buy.
    const { pushes } = run();
    document.querySelector('.ch-tconsent [data-consent="granted"]').click();
    const g = grants(pushes)[0];
    expect(g.ad_storage).toBeUndefined();
    expect(g.ad_user_data).toBeUndefined();
    expect(g.ad_personalization).toBeUndefined();
    // ...and nothing else sneaks in later: exactly one key is ever granted here.
    expect(Object.values(g).filter((v) => v === 'granted')).toEqual(['granted']);
  });

  it('remembers the answer so the strip is asked once, not once per page', () => {
    const { storage } = run();
    document.querySelector('.ch-tconsent [data-consent="granted"]').click();
    expect(storage.last).toEqual(['ceylonhop_consent', 'granted']);
  });
});

describe('a remembered answer', () => {
  it('re-grants silently on the next page, with no strip', () => {
    const { pushes } = run({ stored: 'granted' });
    expect(bar()).toBeNull();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });

  it('respects a refusal — no strip, no grant, no nagging', () => {
    const { pushes } = run({ stored: 'denied' });
    expect(bar()).toBeNull();
    expect(grants(pushes)).toEqual([]);
  });
});

describe('cross-property hand-off', () => {
  it('honours ?chc=1 from another Ceylon Hop property without asking again', () => {
    // quote.ceylonhop.com and pay.ceylonhop.com are separate ORIGINS, so localStorage does
    // not carry between them. Without this, a customer who accepted on the quote page is
    // asked a second time on the pay page and the two hops look like two cold sessions.
    const { pushes, storage } = run({ search: '?t=abc&chc=1' });
    expect(bar()).toBeNull();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
    expect(storage.last).toEqual(['ceylonhop_consent', 'granted']);
  });

  it('ignores chc=0 and any other value — only an explicit 1 carries a grant', () => {
    expect(grants(run({ search: '?chc=0' }).pushes)).toEqual([]);
    expect(bar()).not.toBeNull();
    expect(grants(run({ search: '?chc=yes' }).pushes)).toEqual([]);
  });

  it('a stored refusal beats an inbound ?chc=1', () => {
    // Otherwise a link could silently overturn a decision the customer already made here.
    const { pushes } = run({ search: '?chc=1', stored: 'denied' });
    expect(grants(pushes)).toEqual([]);
  });
});

describe('the owner switch', () => {
  it('defaults to asking first', () => {
    expect(SRC).toMatch(/var ASK_FIRST = true;/);
  });

  it('with ASK_FIRST false, grants analytics immediately and shows no strip', () => {
    // The legitimate-interest posture, should the owner choose it: first-party, no ads,
    // privacy policy linked. Left as a one-line flip because it is a legal call, not an
    // engineering one.
    const { pushes } = run({ src: SRC.replace('var ASK_FIRST = true;', 'var ASK_FIRST = false;') });
    expect(bar()).toBeNull();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });
});

describe('it can never break a payment page', () => {
  it('survives localStorage being unavailable', () => {
    expect(() => run({ throwOnStorage: true })).not.toThrow();
  });

  it('still renders the strip when storage throws, and still grants on click', () => {
    const { pushes } = run({ throwOnStorage: true });
    expect(bar()).not.toBeNull();
    expect(() => document.querySelector('.ch-tconsent [data-consent="granted"]').click()).not.toThrow();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });

  it('links to the privacy policy on the apex, since these pages are on their own hosts', () => {
    run();
    const a = document.querySelector('.ch-tconsent a');
    expect(a.getAttribute('href')).toBe('https://ceylonhop.com/privacy.html');
  });
});
