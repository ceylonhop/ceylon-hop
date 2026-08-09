import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract the real function from ops-ui.html (house loadFn pattern — see ops-map-pins.test.js).
// The Maps key rejects local origins, so the map itself can't render here; this tests the
// grouping the route REQUESTS are built from, which is where the route-variant bug was.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + '\\s*\\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const itinRuns = loadFn('itinRuns(legs)');

const leg = (stops, extra) => Object.assign({ stops }, extra || {});

describe('itinRuns', () => {
  it('routes a plain leg with no route choice on the default (expressway) route', () => {
    expect(itinRuns([leg(['Ella', 'Colombo City'])])).toEqual([
      { stops: ['Ella', 'Colombo City'], avoidTolls: false, continues: false },
    ]);
  });

  // The bug: picking Local road set leg.routeVariant, but the map's request never carried
  // avoidTolls, so ops kept looking at the expressway line it had asked Google for.
  it('asks for the toll-free route when the leg is on Local road', () => {
    const runs = itinRuns([leg(['Ella', 'Colombo City'], { routeVariant: 'no_tolls' })]);
    expect(runs).toHaveLength(1);
    expect(runs[0].avoidTolls).toBe(true);
  });

  it('keeps connected legs that agree on one run — one request, as before', () => {
    const runs = itinRuns([
      leg(['Ella', 'Kandy'], { routeVariant: 'fastest' }),
      leg(['Kandy', 'Colombo City'], { routeVariant: 'fastest' }),
    ]);
    expect(runs).toEqual([
      { stops: ['Ella', 'Kandy', 'Colombo City'], avoidTolls: false, continues: false },
    ]);
  });

  // avoidTolls is a per-REQUEST modifier but routeVariant is per LEG, so a chain whose legs
  // disagree cannot be one query. Split it, and mark the second run as continuing the first
  // so the shared join stop isn't pinned twice.
  it('splits a connected chain where the legs disagree, flagging the join', () => {
    const runs = itinRuns([
      leg(['Ella', 'Kandy'], { routeVariant: 'no_tolls' }),
      leg(['Kandy', 'Colombo City'], { routeVariant: 'fastest' }),
    ]);
    expect(runs).toEqual([
      { stops: ['Ella', 'Kandy'], avoidTolls: true, continues: false },
      { stops: ['Kandy', 'Colombo City'], avoidTolls: false, continues: true },
    ]);
  });

  it('does not stitch disconnected legs, and never flags a gap as a join', () => {
    const runs = itinRuns([
      leg(['Ella', 'Kandy']),
      leg(['Galle', 'Colombo City']),
    ]);
    expect(runs).toEqual([
      { stops: ['Ella', 'Kandy'], avoidTolls: false, continues: false },
      { stops: ['Galle', 'Colombo City'], avoidTolls: false, continues: false },
    ]);
  });

  it('skips stay days, blanks and unroutable one-stop legs', () => {
    const runs = itinRuns([
      leg(['Ella', 'Kandy']),
      leg(['Nowhere'], { category: 'stay_day' }),
      leg(['  ', '']),
      leg(['Galle']),
    ]);
    expect(runs).toEqual([
      { stops: ['Ella', 'Kandy'], avoidTolls: false, continues: false },
    ]);
  });

  it('trims and consecutive-dedups stops the way the chain builder always has', () => {
    const runs = itinRuns([leg([' Ella ', 'Kandy', 'Kandy', 'Colombo City'])]);
    expect(runs[0].stops).toEqual(['Ella', 'Kandy', 'Colombo City']);
  });
});
