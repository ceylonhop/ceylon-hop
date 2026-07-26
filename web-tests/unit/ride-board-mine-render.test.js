import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// Same trick as ride-board.test.js: board.js is a browser IIFE that installs pure
// helpers on window.RideBoard and only boots the DOM app when #board-grid exists.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();
  const src = readFileSync(path.join(ROOT, 'board.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  RB = window.RideBoard;
});

// /board/mine lands a beat after /board has already painted. Re-rendering on it
// unconditionally tore down and rebuilt every card — the whole board visibly re-ran
// its fade-in a moment after appearing. The only thing that second pass can change
// on a card is the "you're on this" marking, which comes from mineCodes, so this
// decides whether the repaint is worth anything at all.
describe('mineMarkChanged — is a post-/board/mine repaint worth doing?', () => {
  it('is exposed as a pure helper', () => {
    expect(typeof RB.mineMarkChanged).toBe('function');
  });

  it('says no when you are on none of the listed rides', () => {
    // the common case for a signed-in browser: mine is empty, nothing is marked
    expect(RB.mineMarkChanged(['GM-1', 'EA-2'], new Set(), [])).toBe(false);
  });

  it('says no when the marking on screen already matches', () => {
    expect(RB.mineMarkChanged(['GM-1', 'EA-2'], new Set(['GM-1']), ['GM-1'])).toBe(false);
  });

  it('says yes when a listed ride is yours but is not marked yet', () => {
    expect(RB.mineMarkChanged(['GM-1', 'EA-2'], new Set(['GM-1']), [])).toBe(true);
  });

  it('says yes when a card is marked but is no longer yours (after a scratch)', () => {
    expect(RB.mineMarkChanged(['GM-1', 'EA-2'], new Set(), ['GM-1'])).toBe(true);
  });

  it('ignores rides of yours that are not on the current board', () => {
    // filtered out, or on another page of the board — nothing on screen to mark
    expect(RB.mineMarkChanged(['GM-1'], new Set(['ZZ-9']), [])).toBe(false);
  });

  it('handles an empty board', () => {
    expect(RB.mineMarkChanged([], new Set(['GM-1']), [])).toBe(false);
  });
});
