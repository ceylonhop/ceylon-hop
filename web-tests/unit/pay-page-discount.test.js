import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../pay.html'), 'utf8');

// Extract the totals renderer from pay.html itself (loadFn pattern — see pay-page-lines.test.js),
// injecting a local esc since the page's esc needs a DOM.
function loadFn(signature) {
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n  \\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in pay.html');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // eslint-disable-next-line no-new-func
  return new Function('esc', 'return (' + m[0] + ')')(esc);
}
const totalsHtml = loadFn('totalsHtml(copy, totals, discount)');

const COPY = { totalLabel: 'Total · all 3 journeys' };
const TOTALS = { cents: 17800, usd: '$178.00' };
const DISCOUNT = { totalBeforeUsd: '$208.00', discountUsd: '$30.00' };

describe('the discount a customer was given, on the pay page', () => {
  it('shows what the trip was, what came off, and what is paid', () => {
    const out = totalsHtml(COPY, TOTALS, DISCOUNT);
    expect(out).toContain('$208.00');
    expect(out).toContain('&minus;$30.00');
    expect(out).toContain('$178.00');
    expect(out).toContain('Final total');
  });

  it('keeps the page’s own richer label on the pre-discount row, so “Total” is not printed twice', () => {
    const out = totalsHtml(COPY, TOTALS, DISCOUNT);
    expect(out).toContain('Total · all 3 journeys');
    expect(out.match(/total/gi)).toHaveLength(2); // the label, and "Final total"
  });

  it('the figure actually paid is the one row that keeps the big treatment', () => {
    const out = totalsHtml(COPY, TOTALS, DISCOUNT);
    // .tot .v is 2rem in ticket.css; .tot-sub knocks it down. The final row takes neither class.
    const final = out.slice(out.indexOf('Final total'));
    expect(final).not.toContain('tot-sub');
    expect(final).toContain('$178.00');
  });

  it('is the plain single-total row when nothing was discounted', () => {
    const out = totalsHtml(COPY, TOTALS, undefined);
    expect(out).toBe('<div class="tot"><span class="l">Total · all 3 journeys</span><span class="v">$178.00</span></div>');
  });

  it('escapes the label', () => {
    expect(totalsHtml({ totalLabel: '<script>x</script>' }, TOTALS, undefined)).not.toContain('<script>');
  });

  it('the muted rows are styled — the size override lands on .v, not the row', () => {
    // ticket.css sets .tot .v{font-size:2rem}. Setting the size on .tot.tot-sub alone never
    // reaches the number, which is exactly the bug #425 had to fix on the quote page.
    expect(html).toMatch(/\.tot\.tot-sub \.v\{[^}]*font-size:1\.05rem/);
    expect(html).toMatch(/\.tot\.tot-final\{[^}]*border-top/);
  });
});
