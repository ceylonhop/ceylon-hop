import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

// checkout-handoff.js — the ONE copy of the PayHere hand-off that booking.html and manage.html
// share (review of #774, finding 9). Before it, each page carried its own form builder and its own
// WhatsApp text, and booking.js wrote manage.html's private sessionStorage keys by heart.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('checkout-handoff.js');

// Comments legitimately describe what the code used to do; the guards are about the CODE.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

function load() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ceylonhop.com/booking.html', runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(`window.__submitted = [];
    HTMLFormElement.prototype.submit = function(){
      window.__submitted.push({ method: this.method, action: this.action, attached: document.body.contains(this),
        inputs: Array.from(this.elements).map(function(i){ return [i.name, i.value, i.type]; }) });
    };`);
  w.eval(SRC);
  return w;
}

const WA_PREFIX = 'https://wa.me/94779669662?text=';
const decoded = (href) => {
  expect(href.startsWith(WA_PREFIX)).toBe(true);
  return decodeURIComponent(href.slice(WA_PREFIX.length));
};

describe('chSubmitToGateway', () => {
  it('POSTs a top-level form to the gateway with every field verbatim, in the server’s order', () => {
    const w = load();
    const fields = { merchant_id: 'm-1', return_url: 'https://x.test/manage.html?rt=b', order_id: 'CH-1', amount: '229.00', currency: 'USD', hash: 'H' };
    w.chSubmitToGateway({ checkoutUrl: 'https://www.payhere.lk/pay/checkout', fields });
    expect(w.__submitted).toHaveLength(1);
    const f = w.__submitted[0];
    expect(f.method).toBe('post');
    expect(f.action).toBe('https://www.payhere.lk/pay/checkout');
    expect(f.attached).toBe(true);
    expect(f.inputs).toEqual(Object.entries(fields).map(([k, v]) => [k, v, 'hidden']));
  });
});

describe('chTellUsHref', () => {
  it("'failed' names the booking in the prefilled message", () => {
    const w = load();
    expect(decoded(w.chTellUsHref('CH-HAFDZ', 'failed')))
      .toBe('Hi Ceylon Hop, my payment for booking CH-HAFDZ didn\'t go through. What I saw: ');
  });

  it('drops the "for booking" clause when there is no reference', () => {
    const w = load();
    expect(decoded(w.chTellUsHref(null, 'failed'))).toBe('Hi Ceylon Hop, my payment didn\'t go through. What I saw: ');
  });

  it("'contact' is a neutral question naming the booking — nothing failed", () => {
    const w = load();
    expect(decoded(w.chTellUsHref('CH-HAFDZ', 'contact'))).toBe('Hi Ceylon Hop, a question about booking CH-HAFDZ: ');
    expect(decoded(w.chTellUsHref(null, 'contact'))).toBe('Hi Ceylon Hop, a question about my booking: ');
  });

  // The payment-failure EMAILS carry the other copy of this text. Read as source: the API is
  // TypeScript and this suite has no loader for it.
  it('matches the payment-failure emails’ copy in api/src/services/notifications.ts', () => {
    const ts = read('api/src/services/notifications.ts');
    const m = /const msg = `(Hi Ceylon Hop, my payment for booking \$\{booking\.reference\}[^`]*)`;/.exec(ts);
    expect(m, 'paymentTroubleWhatsApp() message template not found').not.toBeNull();
    const emailText = m[1].replace('${booking.reference}', 'CH-HAFDZ');
    const w = load();
    expect(decoded(w.chTellUsHref('CH-HAFDZ', 'failed'))).toBe(emailText);
    // …and the email copy points back here.
    expect(ts).toMatch(/checkout-handoff\.js/);
  });
});

describe('booking.html and manage.html use the shared hand-off', () => {
  const PAGES = [
    { page: 'booking.html', code: strip(read('booking.js')), before: /<script src="booking\.js/ },
    { page: 'manage.html', code: strip(read('manage.html')), before: /<script>\s*\(function\(\)\{\s*'use strict';\s*\/\/ "Your booking"/ },
  ];

  for (const { page, code, before } of PAGES) {
    it(`${page} loads checkout-handoff.js, stamped, before its own script`, () => {
      const html = read(page);
      const at = html.search(/<script src="checkout-handoff\.js\?v=[0-9a-f]{10}"><\/script>/);
      expect(at, `${page} must load checkout-handoff.js with a ?v= stamp`).toBeGreaterThan(-1);
      const own = html.search(before);
      expect(own).toBeGreaterThan(-1);
      expect(at).toBeLessThan(own);
    });

    it(`${page} hands off through chSubmitToGateway and builds no form of its own`, () => {
      expect(code).toMatch(/chSubmitToGateway\(checkout\)/);
      expect(code).not.toMatch(/createElement\('form'\)/);
    });

    it(`${page} builds the WhatsApp link with chTellUsHref, not its own copy of the text`, () => {
      expect(code).toMatch(/chTellUsHref\(/);
      expect(code).not.toMatch(/didn\\'t go through\. What I saw/);
    });
  }

  it('manage.html keeps its token under the shared key name, not a private literal', () => {
    const code = strip(read('manage.html'));
    expect(code).toMatch(/CH_MANAGE_TOKEN_KEY/);
    expect(code).not.toMatch(/'chManageToken'/);
  });
});
