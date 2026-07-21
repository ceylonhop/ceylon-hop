import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// shouldPromptRouteChoice is a self-contained guard (no DOM, no state) inside ops-ui.html —
// extract it by source markers and eval it, same trick as ops-route-note.test.js.
function loadFn() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const m = html.match(/function shouldPromptRouteChoice\(leg, ctx\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('shouldPromptRouteChoice not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const should = loadFn();
const OPTS = { fastest: { km: 292, durationMin: 330 }, noTolls: { km: 205, durationMin: 390 } };
const leg = (o) => ({ routeOptions: OPTS, category: 'drives', ...o });
const ctx = (o) => ({ editable: true, modalOpen: false, ...o });

describe('shouldPromptRouteChoice', () => {
  it('prompts on a fresh fork while editable', () => {
    expect(should(leg({}), ctx({}))).toBe(true);
  });
  it('does not prompt when no variants were fetched', () => {
    expect(should(leg({ routeOptions: null }), ctx({}))).toBe(false);
  });
  it('does not prompt once a variant is chosen', () => {
    expect(should(leg({ routeVariant: 'fastest' }), ctx({}))).toBe(false);
  });
  it('does not prompt twice (already prompted flag)', () => {
    expect(should(leg({ _promptedRouteChoice: true }), ctx({}))).toBe(false);
  });
  it('does not prompt while a modal is already open', () => {
    expect(should(leg({}), ctx({ modalOpen: true }))).toBe(false);
  });
  it('does not prompt on a locked (non-editable) quote', () => {
    expect(should(leg({}), ctx({ editable: false }))).toBe(false);
  });
  it('does not prompt on a manual-distance leg', () => {
    expect(should(leg({ manualDistance: true }), ctx({}))).toBe(false);
  });
  it('does not prompt on a stay leg', () => {
    expect(should(leg({ category: 'stay_day' }), ctx({}))).toBe(false);
  });
});
