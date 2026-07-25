import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// quoteMatches and quoteRouteWindow are self-contained (no DOM, no state) inside ops-ui.html —
// extract them by source markers and eval, same trick as ops-route-choice-trigger.test.js.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const quoteMatches = loadFn('quoteMatches(q, row)');
const quoteRouteWindow = loadFn('quoteRouteWindow(routeText, q)');

const row = (o) => ({ customerName: 'Sonja', reference: 'Q-9VUHS', routeText: 'Colombo · Galle', ...o });

describe('quoteMatches', () => {
  it('matches on customer name, case-insensitively', () => {
    expect(quoteMatches('SONJA', row())).toBe(true);
  });
  it('matches on reference', () => {
    expect(quoteMatches('9vuhs', row())).toBe(true);
  });
  it('matches on a place in the route', () => {
    expect(quoteMatches('galle', row())).toBe(true);
  });
  it('does not match an unrelated term', () => {
    expect(quoteMatches('kandy', row())).toBe(false);
  });
  it('matches everything on an empty or whitespace-only query', () => {
    expect(quoteMatches('', row())).toBe(true);
    expect(quoteMatches('   ', row())).toBe(true);
  });
  it('finds an unnamed draft by the label the row actually shows', () => {
    expect(quoteMatches('untitled', row({ customerName: null }))).toBe(true);
  });
  it('does NOT let the query "null" match a quote with null fields', () => {
    // Regression: a template literal would render null as the string "null" and match everything.
    expect(quoteMatches('null', row({ customerName: null, routeText: null }))).toBe(false);
  });
  it('survives a row with no route', () => {
    expect(quoteMatches('sonja', row({ routeText: null }))).toBe(true);
  });
});

describe('quoteRouteWindow', () => {
  it('windows from the matched place, marking the dropped prefix', () => {
    expect(quoteRouteWindow('Colombo Airport · Galle · Ella', 'ella')).toBe('… Ella');
  });
  it('keeps the whole route when the match is in the first place', () => {
    expect(quoteRouteWindow('Colombo Airport · Galle', 'colombo')).toBe('Colombo Airport · Galle');
  });
  it('keeps the whole route when nothing matches the route', () => {
    expect(quoteRouteWindow('Colombo · Galle', 'sonja')).toBe('Colombo · Galle');
  });
  it('keeps the whole route on an empty query', () => {
    expect(quoteRouteWindow('Colombo · Galle', '')).toBe('Colombo · Galle');
  });
  it('returns an empty string when there is no route', () => {
    expect(quoteRouteWindow(null, 'ella')).toBe('');
  });
});
