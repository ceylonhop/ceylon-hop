import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A tester on the live board never scrolled far enough to see "Your ride's not up here?" —
// it is the last cell of the grid, which on a phone is several screen-tall cards down. The
// fix is a fixed bar at the bottom of the viewport, phones only. These pin the parts that
// would silently rot: the wiring to the create modal, the breakpoint, and the three things
// a fixed bar sits on top of if nobody makes room for it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(path.join(root, 'board.html'), 'utf8');
const js = readFileSync(path.join(root, 'board.js'), 'utf8');

// 640px is the breakpoint that matters here, not a generic "phone" one: it is where .board
// drops to a single column and the 4-card cap starts, which is what puts the tile several
// screen-heights down. board.html has more than one block at that width, so collect them all.
function phoneCss() {
  const out = [];
  const needle = '@media(max-width:640px)';
  for (let at = html.indexOf(needle); at !== -1; at = html.indexOf(needle, at + 1)) {
    const open = html.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) { out.push(html.slice(open + 1, i)); break; }
    }
  }
  if (!out.length) throw new Error('no @media(max-width:640px) block in board.html');
  return out.join('\n');
}

describe('the phones-only start-a-list bar', () => {
  it('is in the markup, as a real button', () => {
    expect(html).toMatch(/<div class="start-bar" id="start-bar">/);
    expect(html).toMatch(/<button[^>]*id="start-bar-btn"/);
  });

  it('opens the create modal — the same target as the tile in the grid', () => {
    // openModal(null) is create mode; openModal(code) joins an existing list.
    const wiring = js.match(/getElementById\('start-bar-btn'\)[\s\S]{0,200}?openModal\(null\)/);
    expect(wiring, 'start-bar-btn must be wired to openModal(null)').toBeTruthy();
  });

  it('is hidden by default and only shown on phones', () => {
    expect(html).toMatch(/\.start-bar\{display:none;position:fixed/);
    expect(phoneCss(), 'must be shown in the same block that caps the board').toMatch(/\.start-bar\{display:block\}/);
  });

  it('is ghost, not solid — joining a list stays the loudest action on the board', () => {
    const btn = html.match(/<button[^>]*id="start-bar-btn"[^>]*>/)[0];
    expect(btn).toContain('btn-ghost');
    expect(btn).not.toContain('btn-primary');
    expect(btn).not.toContain('btn-cta');
  });

  it('makes room for itself: page bottom, toast, and the ride detail view', () => {
    const phone = phoneCss();
    // without these the bar covers the footer, lands on the toast, and competes with the
    // detail view's own "add your name"
    expect(phone, 'page needs bottom padding or the footer hides under the bar').toMatch(/body\{padding-bottom:calc\(70px/);
    expect(phone, 'the toast sits at bottom:20px and would land under the bar').toMatch(/\.toast\{bottom:calc\(/);
    expect(phone, 'a ride detail page has its own join CTA').toMatch(/body\.detail-open \.start-bar\{display:none\}/);
  });

  it('clears the iOS home indicator', () => {
    expect(html).toMatch(/\.start-bar\{[^}]*env\(safe-area-inset-bottom,0px\)/);
  });
});
