import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../pay.html'), 'utf8');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Extract page functions by source markers (loadFn pattern — see pay-page-lines.test.js).
function source(signature) {
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + '\\{[\\s\\S]*?\\n  \\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in pay.html');
  return m[0];
}
// eslint-disable-next-line no-new-func
const addOnsHtml = new Function('esc', 'return (' + source('addOnsHtml(addOns)') + ')')(esc);
// eslint-disable-next-line no-new-func
const ticketBody = new Function('esc', 'addOnsHtml', 'return (' + source('ticketBody(c)') + ')')(esc, addOnsHtml);
// eslint-disable-next-line no-new-func
const passAddOnsCell = new Function('esc', 'return (' + source('passAddOnsCell(addOns)') + ')')(esc);

// The add-ons the customer chose, on the page where they pay a whole-trip quote.
describe('pay page names the add-ons the customer chose', () => {
  it('prints an Extras row, one add-on per line', () => {
    const out = addOnsHtml(['Waiting fee — Kandy → Ella', 'Wait for Safari — Ella → Yala']);
    expect(out).toContain('<span class="k">Extras</span>');
    expect(out).toContain('Waiting fee — Kandy → Ella<br>Wait for Safari — Ella → Yala');
  });

  // On the paid pass a third of a phone-width grid wrapped two add-ons into seven lines.
  it('gives the paid pass a full-width Extras cell, one add-on per line', () => {
    const out = passAddOnsCell(['Waiting fee — Kandy → Ella', 'Wait for Safari — Ella → Yala']);
    expect(out).toContain('grid-column:1/-1');
    expect(out).toContain('<div class="k">Extras</div>');
    expect(out).toContain('Waiting fee — Kandy → Ella<br>Wait for Safari — Ella → Yala');
    expect(passAddOnsCell(undefined)).toBe('');
    expect(passAddOnsCell(['<img src=x>'])).not.toContain('<img');
  });

  it('prints nothing when nothing was chosen', () => {
    expect(addOnsHtml(undefined)).toBe('');
    expect(addOnsHtml([])).toBe('');
  });

  it('escapes the labels', () => {
    expect(addOnsHtml(['<img src=x>'])).not.toContain('<img');
  });

  it('sits in the ticket for a single transfer and for a multi-journey trip', () => {
    const single = ticketBody({ facts: [{ k: 'Vehicle', v: 'Private car' }], addOns: ['Waiting fee — Kandy → Ella'] });
    expect(single).toContain('Private car');
    expect(single).toContain('Waiting fee — Kandy → Ella');
    const multi = ticketBody({ facts: [], legs: [{ route: 'Kandy → Ella', date: 'Sat 8 Aug' }], addOns: ['Waiting fee — Kandy → Ella'] });
    expect(multi).toContain('hop-t');
    expect(multi).toContain('Waiting fee — Kandy → Ella');
    expect(ticketBody({ facts: [{ k: 'Vehicle', v: 'Private car' }] })).not.toContain('Extras');
  });
});
