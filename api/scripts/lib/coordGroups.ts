// Groups catalogue towns that pin the SAME physical point (e.g. 'Nilaveli Beach' from the
// quoting tool vs 'Nilaveli' from front-end catalogue parity) so distance-report.ts bills one
// Distance Matrix element per physical pair instead of one per spelling. Pure function —
// coordinate and cache-key lookups are injected so this stays testable offline.
export interface TownGroup {
  /** Display names sharing one coordinate; the first is the group's representative. */
  names: string[];
  /** The distance-cache canon key of each name, in the same order. */
  keys: string[];
}

export function groupTownsByCoords(
  towns: string[],
  coordsOf: (name: string) => [number, number] | null,
  keyOf: (name: string) => string,
): TownGroup[] {
  const groups: TownGroup[] = [];
  const byCoord = new Map<string, TownGroup>();
  for (const name of towns) {
    const coords = coordsOf(name);
    // Unknown coords can't prove two names are the same place, so they never merge.
    const existing = coords ? byCoord.get(coords.join(',')) : undefined;
    if (existing) {
      existing.names.push(name);
      existing.keys.push(keyOf(name));
      continue;
    }
    const group: TownGroup = { names: [name], keys: [keyOf(name)] };
    groups.push(group);
    if (coords) byCoord.set(coords.join(','), group);
  }
  return groups;
}
