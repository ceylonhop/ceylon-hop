import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// setRequestedService is a pure-ish function over `state` inside ops-ui.html — extract it and
// run it against a fake state, same trick as ops-pay-selection.test.js.
//
// Why this file exists (owner, 2026-08-06): "Customer asked for" and "Pricing as" were fully
// decoupled, so picking Chauffeur-guide at intake left the quote priced Point-to-point. Ops
// approved past the mismatch banner, and the customer opened their quote link to a $489
// point-to-point card for a trip they had asked to be chauffeured — and a pay link minted then
// would have CHARGED the point-to-point total for a chauffeur trip. Picking one service now
// moves the priced service with it; 'both' and deliberate overrides still work.
function loadFn(name, freeVars) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = html.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    if (depth === 0) break;
  }
  const src = html.slice(start, i + 1);
  const names = Object.keys(freeVars);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${src}; return ${name};`)(...names.map((n) => freeVars[n]));
}

let state, calls, dates;
const setup = () => {
  state = { requestedService: null, service: 'private', legs: [] };
  calls = { setService: [], markDirty: 0, render: 0 };
  dates = 2; // distinct dated travel days in the itinerary
};
const pricedServiceFor = loadFn('pricedServiceFor', {});
const fns = () => ({
  state,
  requestedIncludes: (dim) => state.requestedService === dim || state.requestedService === 'both',
  setService: (s) => { calls.setService.push(s); state.service = s; },
  pricedServiceFor,
  distinctLegDateCount: () => dates,
  markDirty: () => { calls.markDirty++; },
  render: () => { calls.render++; },
  get outputIncludeChauffeurUpsell() { return false; },
});

// Owner, 2026-10-12: "The first choice is what decides the intention of the customer. If both
// options were chosen, the quote will be shown for both." — and the Pricing as cards stop being
// clickable. So the priced service is a FUNCTION of what was asked for; it is never chosen.
describe('pricedServiceFor — what the customer asked for decides how the quote is priced', () => {
  it.each([
    ['chauffeur', 2, 'private', 'chauffeur'],
    ['chauffeur', 5, 'private', 'chauffeur'],
    ['chauffeur', 1, 'private', 'private'], // a chauffeur trip needs 2+ travel days; until then, point-to-point
    ['chauffeur', 0, 'chauffeur', 'private'],
    ['private', 4, 'chauffeur', 'private'],
    ['both', 4, 'chauffeur', 'private'], // both = the point-to-point price, chauffeur shown alongside
    ['both', 0, 'private', 'private'],
    [null, 4, 'chauffeur', 'chauffeur'], // nothing recorded yet (or a legacy quote): leave it priced as it is…
    [null, 1, 'chauffeur', 'private'], // …but a chauffeur price still needs 2+ travel days
    [null, 4, 'private', 'private'],
  ])('asked %s, %i travel day(s), was %s → %s', (requested, days, current, expected) => {
    expect(pricedServiceFor(requested, days, current)).toBe(expected);
  });
});

describe('customer-asked-for keeps the priced service in step', () => {
  beforeEach(setup);

  it('picking Chauffeur-guide prices the quote as chauffeur', () => {
    const f = fns();
    loadFn('setRequestedService', f)('chauffeur');
    expect(state.requestedService).toBe('chauffeur');
    expect(state.service).toBe('chauffeur');
  });

  it('picking Chauffeur-guide on a one-day itinerary prices point-to-point for now', () => {
    dates = 1;
    const f = fns();
    loadFn('setRequestedService', f)('chauffeur');
    expect(state.requestedService).toBe('chauffeur');
    expect(state.service).toBe('private');
  });

  // These chips are TOGGLES: picking private while chauffeur is on means "they asked for both".
  it('picking Point-to-point from nothing prices the quote as private', () => {
    const f = fns();
    loadFn('setRequestedService', f)('private');
    expect(state.requestedService).toBe('private');
    expect(state.service).toBe('private');
  });

  it('unticking one half of BOTH prices the quote as the survivor', () => {
    state.requestedService = 'both';
    state.service = 'private';
    const f = fns();
    loadFn('setRequestedService', f)('private'); // untick private, leaving chauffeur
    expect(state.requestedService).toBe('chauffeur');
    expect(state.service).toBe('chauffeur');
  });

  it('choosing BOTH prices the quote point-to-point — the chauffeur price rides alongside', () => {
    state.requestedService = 'chauffeur';
    state.service = 'chauffeur';
    const f = fns();
    loadFn('setRequestedService', f)('private');
    expect(state.requestedService).toBe('both');
    expect(state.service).toBe('private');
  });

  it('clearing the last pick leaves the priced service alone', () => {
    state.requestedService = 'chauffeur';
    state.service = 'chauffeur';
    const f = fns();
    loadFn('setRequestedService', f)('chauffeur');
    expect(state.requestedService).toBe(null);
    expect(state.service).toBe('chauffeur');
  });
});
