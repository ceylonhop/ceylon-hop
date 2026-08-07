// consent-transactional.js — the consent path for pay.html and quote.html.
//
// Why a second consent module exists at all: both pages set Consent Mode v2 to `denied`
// and then deliberately omit consent.js, because the floating banner overlaid the pay
// CTA (owner, 2026-08-01 / 2026-08-06). The banner went, but so did every grant — so
// `analytics_storage` stayed denied for the whole session, Clarity's tag never fired,
// and we have no replay of anybody paying.
//
// **The shipped posture is ASK_FIRST = false** (owner, 2026-08-07): grant analytics on
// arrival, ads never. So the SHIPPED behaviour is the small "grants on arrival" block —
// everything else here exercises the strip with the switch forced on, because the owner's
// decision was "revisit at scale", and a dormant path nobody tests is a path that has
// quietly rotted by the time they come back to it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SRC = readFileSync(path.join(ROOT, 'consent-transactional.js'), 'utf8');

// `askFirst: true` flips the owner switch for the tests that exercise the strip. Rewriting
// the constant keeps ONE source of truth — the shipped file — rather than a second copy of
// the module that could drift away from it.
function withAsk(src) {
  const flipped = src.replace('var ASK_FIRST = false;', 'var ASK_FIRST = true;');
  if (flipped === src) throw new Error('ASK_FIRST switch not found — has it been renamed?');
  return flipped;
}

function run({ search = '', stored = null, src = SRC, askFirst = false, throwOnStorage = false } = {}) {
  if (askFirst) src = withAsk(src);
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

// ── what actually ships (ASK_FIRST = false) ──────────────────────────────────────────
describe('the shipped posture: measure on arrival, never advertise', () => {
  it('grants analytics immediately, with no strip and nothing to dismiss', () => {
    const { pushes } = run();
    expect(bar()).toBeNull();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });

  it('NEVER grants advertising, on these pages, ever', () => {
    // The whole basis for granting without asking is that this is first-party measurement
    // on a page someone reached by deciding to buy — no remarketing, no data sold. The
    // moment an ad key appears here that argument is gone, so this is the load-bearing test.
    const g = grants(run().pushes)[0];
    expect(g.ad_storage).toBeUndefined();
    expect(g.ad_user_data).toBeUndefined();
    expect(g.ad_personalization).toBeUndefined();
    expect(Object.values(g).filter((v) => v === 'granted')).toEqual(['granted']);
  });

  it('leaves the page layout completely alone', () => {
    // Nothing renders, so nothing may reserve space either — a stray padding-bottom on a
    // payment page would be a visible bug with no visible cause.
    run();
    expect(document.body.style.paddingBottom).toBe('');
  });

  it('STILL respects a stored refusal — the switch does not overrule a person', () => {
    // manage.html shares this storage key on the apex via consent.js, so a customer who
    // rejected there and then opens a booking link has genuinely said no. Granting anyway
    // because a constant says so would be the one indefensible version of this feature.
    const { pushes } = run({ stored: 'denied' });
    expect(grants(pushes)).toEqual([]);
  });

  it('does not re-write storage when it already says granted', () => {
    const { pushes, storage } = run({ stored: 'granted' });
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
    expect(storage.last).toBeUndefined();
  });
});

// ── the strip, kept alive for the day the owner flips the switch ─────────────────────
// Owner call 2026-08-07 was "false, revisit when we're larger". These run with the switch
// forced on so that day is a one-word change, not a rediscovery of why it was built.
describe('the ask (ASK_FIRST = true)', () => {
  const ask = (opts = {}) => run({ ...opts, askFirst: true });

  it('renders a strip and grants nothing until it is answered', () => {
    const { pushes } = ask();
    expect(bar()).not.toBeNull();
    expect(grants(pushes)).toEqual([]);
  });

  it('reserves its own space instead of floating over the CTA', () => {
    // The owner's original objection: consent.js was position:fixed with nothing reserving
    // room for it, so on a phone it sat squarely on "Pay with PayHere".
    ask();
    expect(document.body.style.paddingBottom).toMatch(/\d+px/);
    expect(parseInt(document.body.style.paddingBottom, 10)).toBeGreaterThan(0);
  });

  it('clears the reserved space again once answered, leaving no gap behind', () => {
    ask();
    document.querySelector('.ch-tconsent [data-consent="granted"]').click();
    expect(bar()).toBeNull();
    expect(document.body.style.paddingBottom).toBe('');
  });

  it('Accept grants analytics only, and remembers it', () => {
    const { pushes, storage } = ask();
    document.querySelector('.ch-tconsent [data-consent="granted"]').click();
    const g = grants(pushes)[0];
    expect(g).toMatchObject({ analytics_storage: 'granted' });
    expect(Object.values(g).filter((v) => v === 'granted')).toEqual(['granted']);
    expect(storage.last).toEqual(['ceylonhop_consent', 'granted']);
  });

  it('No thanks stores the refusal and grants nothing', () => {
    const { pushes, storage } = ask();
    document.querySelector('.ch-tconsent [data-consent="denied"]').click();
    expect(grants(pushes)).toEqual([]);
    expect(storage.last).toEqual(['ceylonhop_consent', 'denied']);
  });

  it('a remembered answer is not asked again', () => {
    expect(bar()).toBeNull();
    const { pushes } = ask({ stored: 'granted' });
    expect(bar()).toBeNull();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });
});

describe('cross-property hand-off', () => {
  // Only observable when the page would otherwise ask; with the shipped switch everything
  // grants anyway. It exists so the quote → pay hop stays one session after a flip.
  it('honours ?chc=1 from another Ceylon Hop property without asking again', () => {
    // quote.ceylonhop.com and pay.ceylonhop.com are separate ORIGINS, so localStorage does
    // not carry between them. Without this a customer is asked twice and the two hops look
    // like two cold sessions with a referral in between.
    const { pushes, storage } = run({ search: '?t=abc&chc=1', askFirst: true });
    expect(bar()).toBeNull();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
    expect(storage.last).toEqual(['ceylonhop_consent', 'granted']);
  });

  it('ignores chc=0 and any other value — only an explicit 1 carries a grant', () => {
    expect(grants(run({ search: '?chc=0', askFirst: true }).pushes)).toEqual([]);
    expect(bar()).not.toBeNull();
    expect(grants(run({ search: '?chc=yes', askFirst: true }).pushes)).toEqual([]);
  });

  it('a stored refusal beats an inbound ?chc=1', () => {
    // Otherwise a link could silently overturn a decision the customer already made here.
    const { pushes } = run({ search: '?chc=1', stored: 'denied', askFirst: true });
    expect(grants(pushes)).toEqual([]);
  });
});

describe('the owner switch', () => {
  it('ships as ASK_FIRST = false — owner call, 2026-08-07, revisit at scale', () => {
    // Pinned deliberately. This constant is the difference between measuring everyone and
    // measuring the minority who opt in, and it is a legal posture decision rather than an
    // engineering one — so it changes when the owner says so, and this test is where they
    // (or a reviewer) find out that it did.
    expect(SRC).toMatch(/var ASK_FIRST = false;/);
  });

  it('is a single assignment, so flipping it really is a one-word change', () => {
    expect(SRC.match(/ASK_FIRST\s*=/g)).toHaveLength(1);
  });
});

describe('it can never break a payment page', () => {
  it('survives localStorage being unavailable', () => {
    expect(() => run({ throwOnStorage: true })).not.toThrow();
  });

  it('still grants when storage throws — private mode must not cost us the measurement', () => {
    const { pushes } = run({ throwOnStorage: true });
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });

  it('still renders the strip when storage throws, and still grants on click', () => {
    const { pushes } = run({ throwOnStorage: true, askFirst: true });
    expect(bar()).not.toBeNull();
    expect(() => document.querySelector('.ch-tconsent [data-consent="granted"]').click()).not.toThrow();
    expect(grants(pushes)[0]).toMatchObject({ analytics_storage: 'granted' });
  });

  it('links to the privacy policy on the apex, since these pages are on their own hosts', () => {
    run({ askFirst: true });
    const a = document.querySelector('.ch-tconsent a');
    expect(a.getAttribute('href')).toBe('https://ceylonhop.com/privacy.html');
  });
});
