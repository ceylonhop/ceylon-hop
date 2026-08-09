import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The file under test can be pointed elsewhere so these guards can be run against an OLD copy of
// pay.html to prove they actually fail on the defective version. Defaults to the real page.
const PAY_HTML = process.env.CH_PAY_HTML
  ? path.resolve(process.env.CH_PAY_HTML)
  : path.resolve(__dirname, '../../pay.html');
const html = readFileSync(PAY_HTML, 'utf8');

// Comments explain the history and legitimately mention the old SDK by name; stripping them keeps
// these guards about the CODE. Block comments only — a '//' strip would eat the '//' in URLs.
const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const js = code.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// Why this file exists: on 2026-08-05 a real customer (CH-XKZL3) could not pay. PayHere's JS SDK
// ran the card form and the 3-D Secure challenge inside a cross-origin iframe, where a failure
// reaches none of its callbacks — the booking and payment rows were created, no webhook ever
// arrived, no error beacon fired, and the customer watched a spinner forever.
// See docs/checkout-redirect-spec.md.
describe('pay page uses a top-level redirect, not the PayHere iframe SDK', () => {
  // THE regression guard. If someone re-adds the SDK, this is the failure that says why not.
  it('does not load PayHere’s JavaScript SDK', () => {
    expect(js).not.toMatch(/payhere\.lk\/lib\/payhere\.js/);
  });

  it('never calls the SDK’s in-page checkout', () => {
    expect(js).not.toMatch(/payhere\s*\.\s*startPayment/);
    expect(js).not.toMatch(/payhere\s*\.\s*on(Completed|Dismissed|Error)/);
  });

  it('submits a real top-level form POST to the gateway’s own URL', () => {
    expect(js).toMatch(/createElement\('form'\)/);
    expect(js).toMatch(/\.method\s*=\s*'POST'/);
    expect(js).toMatch(/\.action\s*=\s*checkout\.checkoutUrl/);
    expect(js).toMatch(/\.submit\(\)/);
  });

  // The hash is signed server-side over merchant_id + order_id + amount + currency. The page must
  // post the server's fields verbatim — building or editing any of them here would be refused by
  // the gateway, or worse, silently charge something else.
  it('posts the server’s checkout fields verbatim', () => {
    expect(js).toMatch(/Object\.keys\(checkout\.fields\)/);
    expect(js).not.toMatch(/fields\.(amount|hash|merchant_id|order_id)\s*=/);
  });

  it('asks the server for a pay-link return, stating intent rather than a URL', () => {
    expect(js).toMatch(/returnTo:\s*'pay-link'/);
    // A client-supplied return URL is a phishing primitive; the server builds it.
    expect(js).not.toMatch(/returnUrl:\s*['"]http/);
  });
});

describe('pay page return leg', () => {
  it('asks our own server for the outcome instead of trusting the redirect', () => {
    expect(js).toMatch(/\/bookings\/pay-return\?rt=/);
  });

  // PayHere documents return_url for an approved payment and cancel_url for a cancellation, but
  // says nothing about where a DECLINED payment lands. So `c=1` may shorten how long we WAIT and
  // change the words — it must never decide the OUTCOME. Only the server's status does that.
  it('never concludes an outcome from the cancel flag', () => {
    // No branch on the hint may render a paid/failed conclusion. The three terminal renderers
    // are reached from the polled status alone.
    expect(js).not.toMatch(/cameFromCancel[\s\S]{0,160}?(renderPaid|renderPaidMinimal)\s*\(/);
    expect(js).not.toMatch(/if\s*\(\s*cameFromCancel\s*\)[\s\S]{0,120}?status\s*=/);
  });

  // Polling a full minute at someone who pressed "Back to Site" — then telling them "Payment
  // received?" — is nonsense. The cancel leg gets a short budget, long enough only to catch a
  // genuine race where they paid and backed out before the webhook landed.
  it('does not make a customer who backed out wait out the full poll budget', () => {
    expect(js).toMatch(/CANCEL_TRIES/);
    const cancel = Number((js.match(/CANCEL_TRIES\s*=\s*(\d+)/) || [])[1]);
    const full = Number((js.match(/RETURN_TRIES\s*=\s*(\d+)/) || [])[1]);
    expect(cancel).toBeGreaterThan(0);
    expect(cancel).toBeLessThan(full);
  });

  it('distinguishes a decline from a slow webhook', () => {
    expect(js).toMatch(/status\s*===\s*'failed'/);
    expect(js).toMatch(/status\s*===\s*'paid'/);
  });
});

describe('pay page survives the round trip and never hangs silently', () => {
  // Without this, every declined payer re-types name, email, phone and a full billing address.
  it('persists what the customer typed before leaving for the gateway', () => {
    expect(js).toMatch(/sessionStorage/);
    expect(js).toMatch(/remember\(\)/);
  });

  // Card data never reaches this origin and must never be written here. The allowed keys are
  // enumerated rather than pattern-matched, so adding a fourth is a deliberate edit to this
  // list and not something that slips through in a diff.
  //
  // `cents` joined t/typed on 2026-08-07: the return leg renders before /view has been
  // re-fetched, so without the trip's own total a real `purchase` reports a value of zero.
  // It is the quote's price — the same number already printed on the page — not PII.
  it('stores only the pay token, the typed form values, and the amount', () => {
    const m = js.match(/setItem\(STORE,\s*JSON\.stringify\(([\s\S]*?)\)\s*\)\s*;/);
    expect(m, 'expected a single STORE write').toBeTruthy();
    const keys = [...m[1].matchAll(/(^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[2]);
    expect(keys.sort()).toEqual(['cents', 't', 'typed']);
    // Whatever the shape, these must never appear in the persisted object.
    expect(m[1]).not.toMatch(/card|cvv|cvc|pan\b|checkoutToken|hash/i);
  });

  // A stalled API used to leave the button reading "Opening secure payment…" forever — a silent
  // hang of our own making, and the one failure mode the redirect does not fix.
  it('puts a deadline on the calls that stand between the customer and the gateway', () => {
    expect(js).toMatch(/AbortController/);
    expect(js).toMatch(/fetchJson\(A \+ '\/quotes\/pay\/start'/);
    expect(js).toMatch(/fetchJson\(A \+ '\/bookings\/' \+ st\.bookingId \+ '\/checkout'/);
  });
});
