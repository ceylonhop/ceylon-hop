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

// Pull the single-line chTrack call for an event out of the source.
const callFor = (event) => {
  const m = src.match(new RegExp(`chTrack\\(\\s*'${event}'\\s*,\\s*\\{[^}]*\\}`));
  return m ? m[0] : '';
};

const OUTCOMES = ['payment_failed', 'payment_dismissed'];

describe('payment outcomes are segmentable, not just countable', () => {
  OUTCOMES.forEach((event) => {
    it(`${event} reports which payment plan it was`, () => {
      expect(callFor(event)).toContain('payment_type:state.payPlan');
    });

    it(`${event} reports how much money was on the line`, () => {
      const call = callFor(event);
      expect(call).toContain('value:calcTotal()');
      expect(call).toContain("currency:'USD'");
    });
  });

  it('the whole outcome set shares the shape of payment_initiated', () => {
    // A failure you cannot compare against its own initiation is a dead end:
    // the funnel only works if both ends carry the same dimensions.
    const initiated = callFor('payment_initiated');
    expect(initiated).toContain('payment_type:state.payPlan');
    OUTCOMES.forEach((event) => {
      ['payment_type', 'currency', 'value'].forEach((param) => {
        expect(callFor(event), `${event} missing ${param}`).toContain(param);
      });
    });
  });

  it('still guards chTrack so a missing analytics.js cannot break checkout', () => {
    OUTCOMES.forEach((event) => {
      const guard = src.match(
        new RegExp(`if\\(typeof window\\.chTrack==='function'\\) window\\.chTrack\\(\\s*'${event}'`),
      );
      expect(guard, `${event} lost its chTrack guard`).toBeTruthy();
    });
  });
});
