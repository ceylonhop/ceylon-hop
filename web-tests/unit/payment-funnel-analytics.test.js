import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ────────────────────────────────────────────────────────────────────────────
//  Payment-outcome analytics (2026-07-30).
//
//  `payment_initiated` carries payment_type/currency/value, but the two failure
//  events carried `{}` — so GA4 could show THAT payments fail and never which
//  plan, or how much money walked. Deposit-vs-full and $40-vs-$400 failures are
//  different problems with different fixes; without params they're one number.
//
//  Source-level assertions: these fire inside PayHere SDK callbacks that a bare
//  jsdom load never reaches. Same approach as ride-board-analytics.test.js.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const src = readFileSync(path.join(ROOT, 'booking.js'), 'utf8');
const manage = readFileSync(path.join(ROOT, 'manage.html'), 'utf8');

// Pull the single-line chTrack call for an event out of the source.
const callFor = (event) => {
  const m = src.match(new RegExp(`chTrack\\(\\s*'${event}'\\s*,\\s*\\{[^}]*\\}`));
  return m ? m[0] : '';
};

// 2026-09-24: the website checkout left PayHere's iframe SDK for a top-level redirect
// (booking-page-redirect.test.js). The two outcome events used to fire from the SDK's
// onError/onDismissed callbacks on booking.html; those callbacks no longer exist. The customer now
// comes back to their booking's manage page, and the OUTCOME is reported there, from our server's
// answer: `payment_failed` on a decline, `payment_cancelled` on the cancel leg (which replaces
// `payment_dismissed`). What this file guarded — that an outcome says how much money was on the
// line, so it can be compared against its own initiation — is now pinned on that return leg.
// (`payment_type` is not carried there: the wizard offers no deposit/full choice any more —
// state.payPlan is always 'full' — so value/currency is what separates one failure from another.)
describe('payment outcomes are segmentable, not just countable', () => {
  it('payment_initiated still reports the plan and the money, behind the chTrack guard', () => {
    const initiated = callFor('payment_initiated');
    expect(initiated).toContain('payment_type:state.payPlan');
    expect(initiated).toContain('value:calcTotal()');
    expect(initiated).toContain("currency:'USD'");
    expect(src).toMatch(/if\(typeof window\.chTrack==='function'\) window\.chTrack\(\s*'payment_initiated'/);
  });

  it('booking.html no longer reports an outcome it cannot know', () => {
    expect(callFor('payment_failed')).toBe('');
    expect(callFor('payment_dismissed')).toBe('');
  });

  it('the return leg’s outcomes report how much money was on the line', () => {
    // moneyOf() is {value, currency}, read from the booking our server returned.
    expect(manage).toMatch(/function moneyOf\(v\)\{\s*return \{ value: [^}]*currency: [^}]*\};/);
    expect(manage).toMatch(/track\('payment_failed', Object\.assign\(moneyOf\(lastView\)/);
    expect(manage).toMatch(/track\(cameFromCancel \? 'payment_cancelled' : 'payment_unconfirmed', Object\.assign\(moneyOf\(lastView\)/);
  });
});
