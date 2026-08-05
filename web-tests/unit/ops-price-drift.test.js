import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract the real function from ops-ui.html (house loadFn pattern) so the test can never drift
// from the page. fmtUsd/esc are injected — the page's own live elsewhere in the file.
function loadFn(signature) {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const re = new RegExp('function ' + signature.replace(/[()]/g, '\\$&') + ' \\{[\\s\\S]*?\\n\\}');
  const m = html.match(re);
  if (!m) throw new Error(signature + ' not found in ops-ui.html');
  const fmtUsd = (c) => '$' + (c / 100).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // eslint-disable-next-line no-new-func
  return new Function('fmtUsd', 'esc', 'return (' + m[0] + ')')(fmtUsd, esc);
}
const priceDriftHtml = loadFn('priceDriftHtml(baselineCents, via, liveCents)');

describe('price-drift indicator', () => {
  it('names the drift when the live total differs', () => {
    const html = priceDriftHtml(10900, 'sent', 9900);
    expect(html).toContain('$109.00');
    expect(html).toContain('$99.00');
    expect(html).toContain('Sent at');
  });

  it('says "Link sent at" when the baseline came from a payment link', () => {
    expect(priceDriftHtml(10900, 'pay_link', 9900)).toContain('Link sent at');
  });

  // Story 2: absence IS the all-clear, so equality must render nothing at all.
  it('renders nothing when the price matches what was quoted', () => {
    expect(priceDriftHtml(10900, 'sent', 10900)).toBe('');
  });

  it('renders nothing when the customer has never been quoted', () => {
    expect(priceDriftHtml(null, null, 9900)).toBe('');
  });

  it('renders nothing when there is no live total to compare', () => {
    expect(priceDriftHtml(10900, 'sent', null)).toBe('');
  });

  // A rise matters as much as a drop — the customer was quoted less than we now want.
  it('shows an increase too', () => {
    expect(priceDriftHtml(9900, 'sent', 15000)).toContain('$150.00');
  });
});
