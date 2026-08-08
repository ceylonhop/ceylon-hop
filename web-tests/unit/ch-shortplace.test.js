import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const require = createRequire(import.meta.url);

// ch-shortplace.js is COMPILED from api/src/quote/shortPlace.ts by `npm run generate`, so this
// file does not re-litigate the shortening rules (api/src/quote/shortPlace.test.ts owns those,
// and CI fails if the committed copy drifts from the source). What it pins is the browser
// contract: that the generated file loads as a classic script, publishes CH.shortPlace, and is
// actually reached by the trip planner.
const { shortPlace, shortenRouteLabel } = require(path.join(ROOT, 'ch-shortplace.js'));

describe('the generated browser copy', () => {
  it('publishes the shortener on the CH namespace, like the other front-end modules', () => {
    const root = {};
    const src = readFileSync(path.join(ROOT, 'ch-shortplace.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('globalThis', src).call(root, root);
    expect(typeof root.CH.shortPlace).toBe('function');
    expect(typeof root.CH.shortenRouteLabel).toBe('function');
  });

  it('is marked generated, so a hand-edit is visibly wrong before CI even runs', () => {
    const src = readFileSync(path.join(ROOT, 'ch-shortplace.js'), 'utf8');
    expect(src).toContain('@generated:shortplace');
    expect(src).toContain('api/src/quote/shortPlace.ts');
    expect(src).toContain('DO NOT EDIT BY HAND');
  });

  it('behaves as the backend does — a spot check that the transpile did not mangle anything', () => {
    expect(shortPlace('The Den 23, Norris Canal Road, Colombo, Sri Lanka')).toBe('The Den 23 · Colombo');
    expect(shortPlace('Ella Mount View Guest Inn, Waterfall Road, Ella, Sri Lanka')).toBe('Ella Mount View Guest Inn');
    // the template literal and the escaped word-boundary regex are the two things a bad
    // transpile would silently break
    expect(shortPlace('Umbrella Cafe, Main Street, Ella, Sri Lanka')).toBe('Umbrella Cafe · Ella');
    expect(shortenRouteLabel('Colombo, Sri Lanka → Kandy, Sri Lanka (car)')).toBe('Colombo → Kandy');
    expect(shortPlace('')).toBe('');
  });
});

describe('the trip-summary route strip', () => {
  // The reported defect: an untouched Google pick and a hand-typed place sat side by side in the
  // same strip and read as two different naming conventions.
  it('renders an autocompleted place and a typed one the same way', () => {
    expect(shortPlace('Jaffna, Sri Lanka')).toBe('Jaffna');
    expect(shortPlace('Colombo city')).toBe('Colombo city');
  });

  it('is wired through the shortener rather than printing the raw place', () => {
    const planJs = readFileSync(path.join(ROOT, 'plan.js'), 'utf8');
    const strip = planJs.match(/routeEl\.innerHTML\s*=\s*\n?\s*seq\.map\([^\n]*\)/);
    expect(strip, 'route-strip render not found in plan.js').toBeTruthy();
    expect(strip[0]).toContain('shortPlaceLabel(s.place)');
    expect(strip[0]).not.toMatch(/\$\{s\.place\}/);
  });

  it('loads the generated script before plan.js, or CH.shortPlace would be undefined at render', () => {
    const html = readFileSync(path.join(ROOT, 'plan.html'), 'utf8');
    const shortIdx = html.indexOf('src="ch-shortplace.js"');
    const planIdx = html.indexOf('src="plan.js"');
    expect(shortIdx, 'ch-shortplace.js not included in plan.html').toBeGreaterThan(-1);
    expect(shortIdx).toBeLessThan(planIdx);
  });
});

describe('Nights, when no overnight stop has been added', () => {
  // "None" read as "this trip has no nights"; the owner ruled out a longer sentence as too wide
  // for the stat cell, so it is a bare 0 matching Places / Transfer legs.
  it('is a bare 0, not a word', () => {
    const planJs = readFileSync(path.join(ROOT, 'plan.js'), 'utf8');
    const line = planJs.match(/setStat\('st-nights',[^\n]*\)/);
    expect(line, 'st-nights render not found in plan.js').toBeTruthy();
    expect(line[0]).toContain(": '0'");
    expect(line[0]).not.toContain('None');
  });
});
