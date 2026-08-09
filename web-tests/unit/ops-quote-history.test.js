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
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // eslint-disable-next-line no-new-func
  return new Function('fmtUsd', 'esc', 'return (' + m[0] + ')')(fmtUsd, esc);
}
const historyRowsHtml = loadFn('historyRowsHtml(revisions)');

const rev = (over = {}) => ({
  revision: 3, totalCents: 9900, updatedBy: 'devan@x.com',
  createdAt: '2026-08-04T10:00:00Z', changed: ['extras', 'total'], ...over,
});

describe('quote history panel', () => {
  it('renders one row per revision, in the order given', () => {
    const html = historyRowsHtml([
      rev(),
      rev({ revision: 2, totalCents: 10900, updatedBy: 'roshen@x.com', changed: ['stops'] }),
    ]);
    expect(html).toContain('$99.00');
    expect(html).toContain('$109.00');
    expect(html).toContain('devan');
    expect(html).toContain('extras');
    expect(html).toContain('stops');
  });

  it('says so plainly when there is no history yet', () => {
    expect(historyRowsHtml([])).toContain('No edits recorded');
  });

  it('escapes the author', () => {
    expect(historyRowsHtml([rev({ updatedBy: '<script>x</script>' })])).not.toContain('<script>');
  });

  it('survives a null author', () => {
    expect(() => historyRowsHtml([rev({ updatedBy: null })])).not.toThrow();
  });

  // A revision where only the price moved must still read as something, not an empty row.
  it('says "no visible change" when nothing was named', () => {
    expect(historyRowsHtml([rev({ changed: [] })])).toContain('no visible change');
  });
});
