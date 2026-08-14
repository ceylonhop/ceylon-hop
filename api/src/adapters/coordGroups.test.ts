import { describe, expect, it } from 'vitest';
import { groupTownsByCoords } from '../../scripts/lib/coordGroups';
import { KNOWN_PLACES, canonPlace, knownCoords } from './maps';

const COORDS: Record<string, [number, number]> = {
  a: [1, 2],
  b: [3, 4],
  'b beach': [3, 4],
};
const coordsOf = (name: string): [number, number] | null => COORDS[name.toLowerCase()] ?? null;
const keyOf = (name: string): string => name.toLowerCase();

describe('groupTownsByCoords', () => {
  it('keeps towns with distinct coordinates in their own groups', () => {
    expect(groupTownsByCoords(['A', 'B'], coordsOf, keyOf)).toEqual([
      { names: ['A'], keys: ['a'] },
      { names: ['B'], keys: ['b'] },
    ]);
  });

  it('merges towns with identical coordinates into one group, first name as representative', () => {
    expect(groupTownsByCoords(['A', 'B Beach', 'B'], coordsOf, keyOf)).toEqual([
      { names: ['A'], keys: ['a'] },
      { names: ['B Beach', 'B'], keys: ['b beach', 'b'] },
    ]);
  });

  it('never merges towns whose coordinates are unknown', () => {
    expect(groupTownsByCoords(['Mystery One', 'Mystery Two'], coordsOf, keyOf)).toEqual([
      { names: ['Mystery One'], keys: ['mystery one'] },
      { names: ['Mystery Two'], keys: ['mystery two'] },
    ]);
  });

  // Regression guard for the real catalogue: 'Nilaveli Beach' (quoting tool) and 'Nilaveli'
  // (front-end catalogue parity) pin the same point, so a full distance-report run must bill
  // their pairings once, not twice. Any new same-point alias added to KNOWN_PLACES will show
  // up here as an extra multi-name group — extend the assertion, don't delete it.
  it('collapses exactly the Nilaveli pair in the real KNOWN_PLACES catalogue', () => {
    const groups = groupTownsByCoords(KNOWN_PLACES, knownCoords, canonPlace);
    const merged = groups.filter((g) => g.names.length > 1);
    expect(merged).toEqual([
      { names: ['Nilaveli Beach', 'Nilaveli'], keys: ['nilaveli beach', 'nilaveli'] },
    ]);
  });
});
