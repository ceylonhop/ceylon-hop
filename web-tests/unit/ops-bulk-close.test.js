import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// Bulk close-out (2026-08-07). The team's "Needs closing" pile is cleared a tick at a time, so
// the queue grew a multi-select. These assert the SAFETY properties of that control, which are
// the ones that would cost real money or goodwill if they regressed.
describe('bulk close-out', () => {
  it('offers Completed only — a bulk no-show would email every one of those customers', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain("{to:'completed'}");
    expect(handler).not.toContain('no_show');
  });

  it('confirms before writing, and says what the action is NOT for', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain('confirm(');
    expect(handler).toMatch(/no-show must be marked one at a time/i);
  });

  it('posts one booking at a time to the same audited endpoint a single Complete uses', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toMatch(/for\s*\(\s*const bid of ids\s*\)/); // sequential, not Promise.all
    expect(handler).not.toContain('Promise.all');
    expect(handler).toContain('/status');
  });

  it('stops on the first failure and keeps the rest ticked so a retry resumes', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain('break;');
    expect(handler).toMatch(/press again to resume/i);
  });

  it('only ever actions rows that are still in Needs closing', () => {
    const handler = html.slice(html.indexOf("case 'closedone'"), html.indexOf("case 'advance'"));
    expect(handler).toContain("dayGroup(x)==='Needs closing'");
  });

  it('goes through the MUTATES guard like every other write', () => {
    expect(html).toMatch(/const MUTATES=\['closedone'/);
  });
});

// The tick box is a FOURTH child of .tk, which is a three-column grid. Shipping the checkbox
// without a matching template pushed name, route and the entire price/stage column out of every
// Needs-closing row in production (owner-caught, 2026-08-07). These two must always travel
// together: emit the tick, declare the column.
describe('the tick box and its grid template ship together', () => {
  it('a row that renders a tick also carries the tk-sel modifier', () => {
    const row = html.slice(html.indexOf('function ticketRow'), html.indexOf('function optionsHtml') > 0 ? html.indexOf('function optionsHtml') : html.indexOf('function ticketRow') + 4000);
    expect(row).toContain('tk-tick');            // the extra child
    expect(row).toContain("closable?'tk-sel':''"); // and the class that makes room for it
  });

  it('.tk.tk-sel declares one more column than .tk', () => {
    const base = html.match(/\.tk\{[^}]*grid-template-columns:([^;]+);/);
    const sel = html.match(/\.tk\.tk-sel\{grid-template-columns:([^;]+)[;}]/);
    expect(base, '.tk must define its columns').toBeTruthy();
    expect(sel, '.tk.tk-sel must define its own columns').toBeTruthy();
    const count = (s) => s.trim().split(/\s+(?![^(]*\))/).length;
    expect(count(sel[1])).toBe(count(base[1]) + 1);
  });
});

// Bodoni 72 ships Book (400) and Bold (700) and nothing else — the brand pass swapped the ops
// display face to it, but seven rules still asked for 600. Browsers synthesise a missing weight,
// and on a face with Bodoni's thick/thin contrast that smears the hairlines into heavy mud at
// row sizes. Owner-reported: "why is everything bold and hard to read" (2026-08-08).
describe('the ops display face only ever asks for weights it has', () => {
  it('no --display rule requests a weight Bodoni 72 does not ship', () => {
    const bad = html.match(/font-family:var\(--display\)[^}]*font-weight:(100|200|300|500|600|800|900)/g) || [];
    expect(bad, `synthesised weights: ${bad.join(' | ')}`).toEqual([]);
  });

  it('and no rule sets the weight before the family either', () => {
    const bad = html.match(/font-weight:(100|200|300|500|600|800|900)[^}]*font-family:var\(--display\)/g) || [];
    expect(bad, `synthesised weights: ${bad.join(' | ')}`).toEqual([]);
  });
});
