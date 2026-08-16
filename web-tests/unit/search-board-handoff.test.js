import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, '../../search.js'), 'utf8');
const css = readFileSync(path.resolve(__dirname, '../../search.html'), 'utf8');

// Shared service runs Wed & Sat, and is reducing from daily to that. On the other 5 days
// the search page used to render a shared card the traveller could not book: the API 400s
// `not_a_service_day` and the datepicker greys the day out. The ride board turns that dead
// end into an offer at the same seat price.
describe('non-service-day handoff to the ride board', () => {
  it('knows whether the searched date is a service day', () => {
    expect(src).toMatch(/const searchDow =/);
    expect(src).toMatch(/shared\.days\.indexOf\(searchDow\) === -1/);
  });

  it('treats a blank date as NOT an off day', () => {
    // `date ? … : null` — a flexible search must still see the scheduled card.
    expect(src).toMatch(/const searchDow = date \?/);
    expect(src).toMatch(/searchDow !== null/);
  });

  it('offers the board instead of an unbookable shared card', () => {
    expect(src).toMatch(/if \(shared && offDay\)/);
    expect(src).toMatch(/Put it on the ride board/);
    expect(src).toMatch(/href="board\.html"/);
  });

  it('quotes the same seat price on the pooled card as the scheduled one', () => {
    // Both branches render `$${shared.seat}` — one price, two commitments.
    const offBranch = src.slice(src.indexOf('if (shared && offDay)'), src.indexOf('} else if (shared)'));
    expect(offBranch).toMatch(/\$\$\{shared\.seat\}/);
  });

  it('still shows the private transfer alongside', () => {
    // The pooled card takes the shared card's slot in the grid; `left` is untouched.
    expect(src).toMatch(/<div class="opt-grid">\$\{left\}/);
  });
});

describe('ride-board strip on search', () => {
  it('asks the board for lists on this exact leg', () => {
    expect(src).toMatch(/\/board\?\$\{qs\.toString\(\)\}/);
    expect(src).toMatch(/from: fromP\.name, to: toP\.name/);
  });

  it('skips the round trip where a list cannot exist', () => {
    // A list only exists on a corridor pair, so a Google-picked place can never have one.
    expect(src).toMatch(/if \(engineRoute \|\| sameEnds\) return;/);
  });

  it('fails silently — the prices are the page, the board is a bonus', () => {
    const fn = src.slice(src.indexOf('loadBoardLists'), src.indexOf('function renderBoardStrip'));
    expect(fn).toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(fn).toMatch(/r\.ok \? r\.json\(\) : null/);
  });

  it('does not route through ch-pricing estimate()', () => {
    // estimate() tracks a single intent; concurrent calls orphan each other.
    const fn = src.slice(src.indexOf('loadBoardLists'), src.indexOf('function renderBoardStrip'));
    expect(fn).not.toMatch(/estimate\(/);
  });

  it('sorts exact-date matches first, then soonest', () => {
    expect(src).toMatch(/\(b\.date === date\) - \(a\.date === date\)/);
  });

  it('deep-links each list to its detail sheet', () => {
    expect(src).toMatch(/board\.html#\/\$\{encodeURIComponent\(l\.code\)\}/);
  });

  it('renders below the option grid, not inside it', () => {
    const render = src.slice(src.indexOf('function renderResults'), src.indexOf('renderResults(engineRoute'));
    expect(render).toMatch(/<\/div>`\s*\+\s*\n?\s*`<section id="board-strip" hidden><\/section>/);
  });

  it('stays hidden until there is something to show', () => {
    expect(src).toMatch(/<section id="board-strip" hidden>/);
    expect(src).toMatch(/if \(!el \|\| !lists\.length\) return;/);
  });

  it('has styles for the strip', () => {
    expect(css).toMatch(/\.board-strip\{/);
    expect(css).toMatch(/\.board-strip \.bs-card\{/);
  });
});
