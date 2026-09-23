import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// ────────────────────────────────────────────────────────────────────────────
// A ride stops taking names at its cutoff — the join route refuses one past it
// (409 'closed', #597). The board never checked: the countdown clamped to
// "closes in 0m 00s" while the card still offered "Hop on". A traveller tapped
// it, worked through the join sheet, typed their phone, address and city, and
// only on submit were they told the ride had closed.
//
// It is not a corner case. Rides are marked closed by a sweep that runs once a
// day, so any ride whose cutoff passes just after a sweep sits like this for
// nearly 24 h. EA-8707 on production was in exactly this state.
//
// `confirmed` already suppressed the invitation; what was missing is the ride
// that is still *gathering* when its deadline goes by.
// ────────────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB, src;
beforeAll(() => {
  loadTransfers();
  src = readFileSync(path.join(ROOT, 'board.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  RB = window.RideBoard;
});

const NOW = Date.parse('2026-09-22T18:00:00Z'); // date-bomb-ok: fixed clock, pure fn
const OPEN = NOW + 6 * 3600e3;
const SHUT = NOW - 60e3;
const L = (o) => ({ minSeats: 4, capacity: 6, committed: 1, confirmed: false, slot: 'morning', cutoffMs: OPEN, ...o });

describe('RideBoard.isClosed(list, now)', () => {
  it('is exposed, and is true only once the cutoff has actually gone by', () => {
    expect(typeof RB.isClosed).toBe('function');
    expect(RB.isClosed(L({ cutoffMs: OPEN }), NOW)).toBe(false);
    expect(RB.isClosed(L({ cutoffMs: SHUT }), NOW)).toBe(true);
    expect(RB.isClosed(L({ cutoffMs: NOW }), NOW)).toBe(true); // the instant itself is shut
  });

  it('treats a ride with no cutoff as open rather than guessing', () => {
    expect(RB.isClosed(L({ cutoffMs: NaN }), NOW)).toBe(false);
    expect(RB.isClosed(L({ cutoffMs: undefined }), NOW)).toBe(false);
  });
});

describe('rowState — a ride past its cutoff never invites a join', () => {
  it('says it is closed and offers a look instead of "Hop on"', () => {
    const s = RB.rowState(L({ committed: 3, cutoffMs: SHUT }), false, NOW);
    expect(s.cta.text).not.toBe('Hop on');
    expect(s.cta).toEqual({ kind: 'view', text: "See who's going" });
    expect(`${s.label} ${s.sub}`).toMatch(/closed/i);
  });

  it('closes a ride that had already reached its minimum but never confirmed', () => {
    const s = RB.rowState(L({ committed: 4, cutoffMs: SHUT }), false, NOW);
    expect(s.cta.text).not.toBe('Hop on');
  });

  it('still says "View your ride" to someone already on it', () => {
    expect(RB.rowState(L({ committed: 2, cutoffMs: SHUT }), true, NOW).cta)
      .toEqual({ kind: 'view', text: 'View your ride' });
  });

  it('leaves an open ride exactly as it was', () => {
    expect(RB.rowState(L({ committed: 3, cutoffMs: OPEN }), false, NOW))
      .toEqual({ cls: 'g', label: '3 of 4 in', sub: 'needs 1 more', cta: { kind: 'view', text: 'Hop on' } });
  });

  it('a full ride still says "Start another taxi", closed or not', () => {
    expect(RB.rowState(L({ committed: 6, cutoffMs: SHUT }), false, NOW).cta)
      .toEqual({ kind: 'again', text: 'Start another taxi' });
  });

  it('defaults to the real clock when no time is passed, so old callers are safe', () => {
    // far-future cutoff: open under any clock
    expect(RB.rowState(L({ committed: 3, cutoffMs: Date.parse('2099-01-01T00:00:00Z') }), false).cta.text)
      .toBe('Hop on');
  });
});

describe('the countdown stops claiming the ride is about to close', () => {
  it('says the names are closed rather than clamping to "closes in 0m 00s"', () => {
    expect(RB.cdText(Date.now() - 60e3)).toBe('names closed');
    expect(RB.cdText(Date.now())).toBe('names closed');
  });

  it('still counts down while the ride is open', () => {
    expect(RB.cdText(Date.now() + 90 * 60e3)).toMatch(/^closes in /);
  });
});

describe('the ride sheet does not offer a join on a closed ride', () => {
  it('gates the join button on the cutoff, not only on confirmed', () => {
    const at = src.indexOf('data-detail-join');
    expect(at).toBeGreaterThan(-1);
    // the sheet builds its join card from a closed flag, the same one the row uses
    const block = src.slice(Math.max(0, at - 2500), at + 500);
    expect(block).toMatch(/shut|isClosed/);
  });

  it('tells the traveller why, instead of a dead button', () => {
    expect(src).toMatch(/names (have )?closed|closed for names|no longer taking names/i);
  });
});

// The ops side of this same blind spot is covered where those helpers actually live, with
// real behavioural tests rather than source matching:
// api/src/routes/opsUi.board.test.ts — "stops asking for more names once the cutoff has gone by".
