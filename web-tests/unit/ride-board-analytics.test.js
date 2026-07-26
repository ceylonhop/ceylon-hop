import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ────────────────────────────────────────────────────────────────────────────
//  Ride-board funnel analytics (2026-07-26).
//
//  board.html was fully wired to GTM but board.js fired exactly one event
//  ('exception'), so the board's conversion funnel was invisible in GA4.
//  These pin the funnel: every step must keep firing, and none of them may
//  carry personal data. Source-level assertions, because the events fire deep
//  inside DOM/fetch handlers that a bare jsdom load never reaches.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let src;
beforeAll(() => { src = readFileSync(path.join(ROOT, 'board.js'), 'utf8'); });

// browse → open a van → intend to join → sign in → joined
const FUNNEL = [
  ['view_item_list', 'the board rendered'],
  ['select_item', 'a van was opened'],
  ['begin_checkout', 'the join modal opened'],
  ['login', 'signed in with Google'],
  ['join_ride', 'a name went on a van'],
  ['create_ride_list', 'a new van was started'],
  ['scratch_ride', 'a name came off'],
];

describe('the ride-board funnel is instrumented end to end', () => {
  FUNNEL.forEach(([event, when]) => {
    it(`fires ${event} when ${when}`, () => {
      expect(src).toContain(`'${event}'`);
    });
  });

  it('routes every event through the shared, never-throw chTrack helper', () => {
    expect(src).toContain('if (window.chTrack) window.chTrack(name, params || {});');
  });

  it('tags every event with one list id so GA4 can segment the board', () => {
    expect(src).toContain("var LIST_ID = 'ride_board';");
  });

  it('does not fire purchase — no money moves until the van locks at cutoff', () => {
    // A held card is not a sale. Firing purchase here would inflate revenue.
    expect(src).not.toContain("ev('purchase'");
  });
});

describe('the funnel carries no personal data', () => {
  const FORBIDDEN = ['email', 'firstName', 'photoUrl', 'sub:', 'credential'];

  /** Every `ev( … )` call, sliced by matching parens (one is a ternary, so a
   *  flat regex misses it). */
  function evCalls(source) {
    const out = [];
    let at = source.indexOf('ev(');
    while (at !== -1) {
      // skip identifiers that merely END in "ev(" — we want the bare helper
      const before = source[at - 1] || '';
      if (!/[A-Za-z0-9_$.]/.test(before)) {
        let depth = 0;
        for (let i = source.indexOf('(', at); i < source.length; i++) {
          if (source[i] === '(') depth++;
          else if (source[i] === ')' && --depth === 0) { out.push(source.slice(at, i + 1)); break; }
        }
      }
      at = source.indexOf('ev(', at + 1);
    }
    return out;
  }

  it('never puts an identifier in an analytics payload', () => {
    const calls = evCalls(src);
    expect(calls.length).toBeGreaterThanOrEqual(FUNNEL.length - 1); // join/create share one ternary call
    calls.forEach((call) => {
      FORBIDDEN.forEach((bad) => {
        expect(call, `${bad} must not reach analytics`).not.toContain(bad);
      });
    });
  });
});

describe('the board reports handled failures, not just crashes', () => {
  it('sends handled errors to the same /errors/client endpoint the head beacon uses', () => {
    expect(src).toContain("API_BASE + '/errors/client'");
  });

  it('caps reports per page so a failing loop cannot flood the ingest', () => {
    expect(src).toContain('REPORT_CAP');
    expect(src).toContain('if (_reported >= REPORT_CAP) return;');
  });

  it('names the call site on every report so Sentry groups by operation', () => {
    ['loadBoard', 'myRides', 'openDetail', 'scratch', 'signIn', 'join'].forEach((ctx) => {
      expect(src).toContain(`report(e, '${ctx}')`);
    });
  });

  it('keeps the beacon best-effort — it must never break the page', () => {
    expect(src).toContain('keepalive: true');
  });
});
