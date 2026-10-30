import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// The ride board kept its own list of pick-up points, and it disagreed with the shared
// catalogue the rest of the site sells from: Sigiriya was "Dambulla junction" on the board
// and Barista Cafe everywhere else (owner, 2026-10-29: "At Sigiriya Barista cafe is our
// partner"). The board now takes a town's point from the catalogue wherever the catalogue
// names one, and keeps its own only for towns the catalogue does not serve.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let T, RB;
beforeAll(() => {
  T = loadTransfers();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'ride-fomo.js'), 'utf8'))();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'board.js'), 'utf8'))();
  RB = window.RideBoard;
});

describe('TRANSFERS.meetingPoint(placeId)', () => {
  it('names the catalogue point for every town a shared taxi stops at', () => {
    expect(T.meetingPoint('sigiriya')).toBe('Barista Cafe, Sigiriya');
    expect(T.meetingPoint('kandy')).toBe('Kandy City Centre');
    expect(T.meetingPoint('ella')).toBe('Barn by Starbeans Cafe, Ella');
    expect(T.meetingPoint('negombo')).toBe('Zen Cafe, Negombo');
    expect(T.meetingPoint('weligama')).toBe('Nomad Cafe, Weligama');
    expect(T.meetingPoint('mirissa')).toBe('Barista Cafe, Mirissa');
    expect(T.meetingPoint('ahangama')).toBe("Thileni's, Ahangama");
    expect(T.meetingPoint('yala')).toBe('Chef Lady, Tissamaharama');
    expect(T.meetingPoint('cmb-airport')).toBe('CMB Airport');
  });

  it('is null for a town the catalogue does not serve', () => {
    expect(T.meetingPoint('galle')).toBeNull();
    expect(T.meetingPoint('nope')).toBeNull();
  });
});

describe('the board uses the catalogue point', () => {
  it('names the catalogue point wherever the catalogue has one', () => {
    expect(RB.pointFor('Sigiriya / Dambulla', 'sigiriya')).toBe('Barista Cafe, Sigiriya');
    expect(RB.pointFor('Ella', 'ella')).toBe('Barn by Starbeans Cafe, Ella');
    expect(RB.pointFor('Kandy')).toBe('Kandy City Centre');
  });

  it('keeps its own point for a town the catalogue does not serve', () => {
    expect(RB.pointFor('Galle', 'galle')).toBe('Galle — Fort clock tower');
  });
});
