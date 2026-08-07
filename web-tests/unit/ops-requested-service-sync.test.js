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

let state, calls;
const setup = () => {
  state = { requestedService: null, service: 'private', legs: [] };
  calls = { setService: [], markDirty: 0, render: 0 };
};
const fns = () => ({
  state,
  requestedIncludes: (dim) => state.requestedService === dim || state.requestedService === 'both',
  setService: (s) => { calls.setService.push(s); state.service = s; },
  markDirty: () => { calls.markDirty++; },
  render: () => { calls.render++; },
  get outputIncludeChauffeurUpsell() { return false; },
});

describe('customer-asked-for keeps the priced service in step', () => {
  beforeEach(setup);

  it('picking Chauffeur-guide prices the quote as chauffeur', () => {
    const f = fns();
    loadFn('setRequestedService', f)('chauffeur');
    expect(state.requestedService).toBe('chauffeur');
    expect(calls.setService).toEqual(['chauffeur']);
  });

  // These chips are TOGGLES: picking private while chauffeur is on means "they asked for both".
  // Landing on a single service — from nothing, or by unticking the other — is what moves the
  // priced service.
  it('picking Point-to-point from nothing prices the quote as private', () => {
    const f = fns();
    loadFn('setRequestedService', f)('private');
    expect(state.requestedService).toBe('private');
    expect(calls.setService).toEqual(['private']);
  });

  it('unticking one half of BOTH prices the quote as the survivor', () => {
    state.requestedService = 'both';
    state.service = 'private';
    const f = fns();
    loadFn('setRequestedService', f)('private'); // untick private, leaving chauffeur
    expect(state.requestedService).toBe('chauffeur');
    expect(calls.setService).toEqual(['chauffeur']);
  });

  it('choosing BOTH leaves the priced service alone — ops decides which one to price', () => {
    state.requestedService = 'private';
    const f = fns();
    loadFn('setRequestedService', f)('chauffeur');
    expect(state.requestedService).toBe('both');
    expect(calls.setService).toEqual([]);
  });

  it('clearing the last pick leaves the priced service alone', () => {
    state.requestedService = 'chauffeur';
    state.service = 'chauffeur';
    const f = fns();
    loadFn('setRequestedService', f)('chauffeur');
    expect(state.requestedService).toBe(null);
    expect(calls.setService).toEqual([]);
  });
});
