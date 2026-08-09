import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Both maps carry their own copy (see ch-map-pins.test.js for why). Load both and run every
// case against each, so a fix that lands in one and not the other fails here.
function extract(file, sig) {
  const src = readFileSync(path.resolve(__dirname, '../../', file), 'utf8');
  const re = new RegExp('(?:^|\\n)([ \\t]*)function ' + sig.replace(/[()]/g, '\\$&') + '\\s*\\{[\\s\\S]*?\\n\\1\\}');
  const m = src.match(re);
  if (!m) throw new Error(sig + ' not found in ' + file);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0].trim() + ')')();
}
const copies = {
  website: extract('ch-map.js', 'mapPins(pts, zoom)'),
  ops: extract('api/src/routes/ops-ui.html', 'mapPins(pts, zoom)'),
};
const labels = {
  website: extract('ch-map.js', 'pinLabelsVisible(zoom)'),
  ops: extract('api/src/routes/ops-ui.html', 'pinLabelsVisible(zoom)'),
};

const P = (lat, lng) => ({ lat, lng });
// Real Sri Lankan stops from the reported 26-stop itinerary's crowded corner.
const NUWARA_ELIYA = P(6.9497, 80.7891);
const NEARBY_HILL = P(6.9702, 80.7625); // ~3 km away — a different stop, same map corner
const GALLE = P(6.0329, 80.217);
const COLOMBO = P(6.9271, 79.8612);

for (const [name, mapPins] of Object.entries(copies)) {
  describe(`mapPins (${name}) — zoom-aware merging`, () => {
    it('merges two distinct stops that collide at country zoom', () => {
      const pins = mapPins([NUWARA_ELIYA, NEARBY_HILL], 7);
      expect(pins).toHaveLength(1);
      expect(pins[0].text).toBe('1–2'); // consecutive → a range, not "1·2"
    });

    it('separates those same stops once you zoom in', () => {
      expect(mapPins([NUWARA_ELIYA, NEARBY_HILL], 13)).toHaveLength(2);
    });

    it('leaves far-apart stops alone even at country zoom', () => {
      expect(mapPins([COLOMBO, GALLE], 7)).toHaveLength(2);
    });

    // The round-trip fix must survive at ANY zoom: the same place is the same pin, always.
    it('still merges a genuine round trip at maximum zoom', () => {
      const pins = mapPins([COLOMBO, GALLE, COLOMBO], 20);
      expect(pins).toHaveLength(2);
      expect(pins[0].text).toBe('1·3'); // non-consecutive → dot-joined
      expect(pins[0].isFirst).toBe(true);
      expect(pins[0].isLast).toBe(true);
    });

    it('collapses a long consecutive run into a range', () => {
      const cluster = [NUWARA_ELIYA, NEARBY_HILL, P(6.96, 80.77), P(6.955, 80.78)];
      const pins = mapPins(cluster, 7);
      expect(pins).toHaveLength(1);
      expect(pins[0].text).toBe('1–4');
    });

    it('falls back to same-place merging when no zoom is given', () => {
      const pins = mapPins([COLOMBO, GALLE, COLOMBO]);
      expect(pins).toHaveLength(2);
      expect(pins[0].text).toBe('1·3');
    });

    it('never throws on empty or single input', () => {
      expect(mapPins([], 7)).toEqual([]);
      expect(mapPins([COLOMBO], 7).map((p) => p.text)).toEqual(['1']);
    });
  });

  describe(`pinLabelsVisible (${name})`, () => {
    it('hides numbers at country zoom, where 26 of them are unreadable', () => {
      expect(labels[name](7)).toBe(false);
    });
    it('shows them once the map is zoomed into a region', () => {
      expect(labels[name](10)).toBe(true);
    });
    it('shows them when zoom is unknown — never silently blank', () => {
      expect(labels[name](undefined)).toBe(true);
    });
  });
}

describe('the two copies agree', () => {
  const cases = [
    ['collide at country zoom', [NUWARA_ELIYA, NEARBY_HILL], 7],
    ['separate when zoomed', [NUWARA_ELIYA, NEARBY_HILL], 13],
    ['round trip at max zoom', [COLOMBO, GALLE, COLOMBO], 20],
    ['no zoom given', [COLOMBO, GALLE, COLOMBO], undefined],
    ['empty', [], 7],
  ];
  for (const [name, pts, zoom] of cases) {
    it(name, () => expect(copies.website(pts, zoom)).toEqual(copies.ops(pts, zoom)));
  }
});
