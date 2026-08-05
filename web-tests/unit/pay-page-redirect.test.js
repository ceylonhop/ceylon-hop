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
  // says nothing about where a DECLINED payment lands — so the `c=1` hint must never be read as
  // an outcome, and both legs must poll the same way.
  it('treats the cancel flag as a display hint, never as a payment status', () => {
    const hintUses = js.match(/cameFromCancel/g) || [];
    // Set once from the URL, read once for copy. Any more and it is probably driving logic.
    expect(hintUses.length).toBeLessThanOrEqual(2);
    expect(js).not.toMatch(/cameFromCancel\s*\)\s*\{[\s\S]{0,200}?(renderPaid|status\s*=)/);
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

  // Card data never reaches this origin and must never be written here.
  it('stores only the pay token and the typed form values', () => {
    const m = js.match(/setItem\(STORE,\s*JSON\.stringify\(([^)]*)\)/);
    expect(m, 'expected a single STORE write').toBeTruthy();
    expect(m[1]).toMatch(/^\s*\{\s*t:\s*t,\s*typed:\s*typed\s*\}\s*$/);
  });

  // A stalled API used to leave the button reading "Opening secure payment…" forever — a silent
  // hang of our own making, and the one failure mode the redirect does not fix.
  it('puts a deadline on the calls that stand between the customer and the gateway', () => {
    expect(js).toMatch(/AbortController/);
    expect(js).toMatch(/fetchJson\(A \+ '\/quotes\/pay\/start'/);
    expect(js).toMatch(/fetchJson\(A \+ '\/bookings\/' \+ st\.bookingId \+ '\/checkout'/);
  });
});
