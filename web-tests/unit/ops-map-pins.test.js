import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract the real function from ops-ui.html (house loadFn pattern). The Maps key rejects local
// origins, so the map itself can't be rendered here — this tests the grouping the pins are built
// from, which is where the bug was.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + '\\s*\\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const mapPins = loadFn('mapPins(pts, zoom)');

const P = (lat, lng) => ({ lat, lng });

describe('mapPins', () => {
  // A round trip has THREE stops across two legs, and the last lands on the first. Before this,
  // pin 3 was drawn on top of pin 1 and the map appeared to start numbering at 2 (owner-reported).
  it('merges a round trip’s repeated stop into one pin carrying both numbers', () => {
    const pins = mapPins([P(6.8649, 79.8997), P(6.42, 79.999), P(6.8649, 79.8997)]);
    expect(pins).toHaveLength(2);
    expect(pins[0].text).toBe('1·3');
    expect(pins[1].text).toBe('2');
    // Every stop is still accounted for — nothing silently disappears.
    expect(pins.flatMap((p) => p.stops).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('leaves a plain A → B → C itinerary numbered 1, 2, 3', () => {
    const pins = mapPins([P(1, 1), P(2, 2), P(3, 3)]);
    expect(pins.map((p) => p.text)).toEqual(['1', '2', '3']);
  });

  it('keeps the first/last tones on a merged pin — it is both start and end', () => {
    const pins = mapPins([P(6.8649, 79.8997), P(6.42, 79.999), P(6.8649, 79.8997)]);
    expect(pins[0].isFirst).toBe(true);
    expect(pins[0].isLast).toBe(true);
    expect(pins[1].isFirst).toBe(false);
  });

  it('handles a place visited three times', () => {
    const pins = mapPins([P(1, 1), P(2, 2), P(1, 1), P(3, 3), P(1, 1)]);
    expect(pins).toHaveLength(3);
    expect(pins[0].text).toBe('1·3·5');
  });

  it('treats coordinates within a few metres as the same place', () => {
    // Google snaps to the road network, so a return leg can land metres from where it started.
    const pins = mapPins([P(6.8649, 79.8997), P(6.42, 79.999), P(6.86491, 79.89972)]);
    expect(pins).toHaveLength(2);
    expect(pins[0].text).toBe('1·3');
  });

  it('does NOT merge two genuinely different places that are merely close', () => {
    // ~1.5 km apart — different hotels on one strip must stay separate pins.
    const pins = mapPins([P(6.8649, 79.8997), P(6.8789, 79.8997)]);
    expect(pins).toHaveLength(2);
  });

  it('never throws on empty or single input', () => {
    expect(mapPins([])).toEqual([]);
    expect(mapPins([P(1, 1)]).map((p) => p.text)).toEqual(['1']);
  });
});
