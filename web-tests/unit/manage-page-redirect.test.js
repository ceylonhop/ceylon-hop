import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../manage.html'), 'utf8');

// Comments explain the history and legitimately mention the old SDK by name; stripping them keeps
// these guards about the CODE. Block comments only — a '//' strip would eat the '//' in URLs.
const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const js = code.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// Why this file exists: on 2026-09-24 PayHere's decline list showed two silent website failures
// (CH-Y5RXW, CH-V43ZU) as "3ds Authentication Failed", with no notify ever reaching us — the 3-D
// Secure bank challenge dying inside the SDK's cross-origin iframe, exactly as
// docs/checkout-redirect-spec.md §1.4 predicted. pay.html moved to a top-level redirect in
// #310–#318; manage.html, where the watchdog's "Finish your booking" email and the ops drawer's
// pay link send customers, still ran the iframe. Same guards as pay-page-redirect.test.js.
describe('manage page uses a top-level redirect, not the PayHere iframe SDK', () => {
  it('does not load PayHere’s JavaScript SDK', () => {
    expect(js).not.toMatch(/payhere\.lk\/lib\/payhere\.js/);
  });

  it('never calls the SDK’s in-page checkout', () => {
    expect(js).not.toMatch(/payhere\s*\.\s*startPayment/);
    expect(js).not.toMatch(/payhere\s*\.\s*on(Completed|Dismissed|Error)/);
  });

  it('submits a real top-level form POST to the gateway’s own URL, fields verbatim', () => {
    expect(js).toMatch(/createElement\('form'\)/);
    expect(js).toMatch(/\.method\s*=\s*'POST'/);
    expect(js).toMatch(/\.action\s*=\s*checkout\.checkoutUrl/);
    expect(js).toMatch(/Object\.keys\(checkout\.fields\)/);
    expect(js).not.toMatch(/fields\.(amount|hash|merchant_id|order_id)\s*=/);
    expect(js).toMatch(/\.submit\(\)/);
  });

  it('asks the server for a manage return, stating intent rather than a URL', () => {
    expect(js).toMatch(/returnTo:\s*'manage'/);
    expect(js).not.toMatch(/returnUrl:\s*['"]http/);
  });
});

describe('manage page return leg', () => {
  it('asks our own server for the outcome instead of trusting the redirect', () => {
    expect(js).toMatch(/\/bookings\/pay-return\?rt=/);
    expect(js).toMatch(/status\s*===\s*'failed'/);
    expect(js).toMatch(/status\s*===\s*'paid'/);
  });

  // `c=1` may shorten the wait and change the words; it must never decide the OUTCOME.
  it('never concludes an outcome from the cancel flag', () => {
    expect(js).not.toMatch(/cameFromCancel[\s\S]{0,160}?(trackPurchase|renderPaidMinimal)\s*\(/);
    expect(js).not.toMatch(/if\s*\(\s*cameFromCancel\s*\)[\s\S]{0,120}?status\s*=/);
    const cancel = Number((js.match(/CANCEL_TRIES\s*=\s*(\d+)/) || [])[1]);
    const full = Number((js.match(/RETURN_TRIES\s*=\s*(\d+)/) || [])[1]);
    expect(cancel).toBeGreaterThan(0);
    expect(cancel).toBeLessThan(full);
  });
});
