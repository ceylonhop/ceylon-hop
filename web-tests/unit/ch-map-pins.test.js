import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// mapPins() exists TWICE on purpose: the ops shell is a self-contained single-file app on a
// different origin and cannot import ch-map.js. There is no shared runtime to put it in — so this
// test loads BOTH copies and asserts they agree, which is the only thing standing between a
// deliberate duplicate and a silent divergence.
function extract(file, sig) {
  const src = readFileSync(path.resolve(__dirname, '../../', file), 'utf8');
  // Close on a brace at the SAME indent as `function` — one copy sits at column 0, the other
  // inside an IIFE at two spaces, and a looser pattern truncates at an inner `}` and silently
  // evaluates half a function.
  const re = new RegExp('(?:^|\\n)([ \\t]*)function ' + sig.replace(/[()]/g, '\\$&') + '\\s*\\{[\\s\\S]*?\\n\\1\\}');
  const m = src.match(re);
  if (!m) throw new Error(sig + ' not found in ' + file);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0].trim() + ')')();
}
const websitePins = extract('ch-map.js', 'mapPins(pts)');
const opsPins = extract('api/src/routes/ops-ui.html', 'mapPins(pts)');

const P = (lat, lng) => ({ lat, lng });
const ROUND_TRIP = [P(6.8649, 79.8997), P(6.42, 79.999), P(6.86492, 79.89968)];

describe('ch-map.js mapPins', () => {
  it('merges a round trip’s repeated stop into one pin', () => {
    const pins = websitePins(ROUND_TRIP);
    expect(pins).toHaveLength(2);
    expect(pins[0].text).toBe('1·3');
    expect(pins[1].text).toBe('2');
    expect(pins[0].isFirst).toBe(true);
    expect(pins[0].isLast).toBe(true);
  });

  it('leaves a straight A → B → C run numbered 1, 2, 3', () => {
    expect(websitePins([P(1, 1), P(2, 2), P(3, 3)]).map((p) => p.text)).toEqual(['1', '2', '3']);
  });

  it('does not merge two different places that are merely close', () => {
    expect(websitePins([P(6.8649, 79.8997), P(6.8789, 79.8997)])).toHaveLength(2);
  });

  it('never throws on empty input', () => {
    expect(websitePins([])).toEqual([]);
  });
});

describe('the two copies agree', () => {
  const cases = [
    ['round trip', ROUND_TRIP],
    ['straight run', [P(1, 1), P(2, 2), P(3, 3)]],
    ['thrice-visited base', [P(1, 1), P(2, 2), P(1, 1), P(3, 3), P(1, 1)]],
    ['near-but-distinct', [P(6.8649, 79.8997), P(6.8789, 79.8997)]],
    ['single stop', [P(1, 1)]],
    ['empty', []],
  ];
  for (const [name, pts] of cases) {
    it(`ops and website produce the same pins — ${name}`, () => {
      expect(websitePins(pts)).toEqual(opsPins(pts));
    });
  }
});
