import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../manage.html'), 'utf8');

// Pull named functions out of manage.html (loadFn pattern — see manage-pickup.test.js).
function grab(name) {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}`));
  if (!m) throw new Error(`${name} not found in manage.html`);
  return m[0];
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (c, cur) => `${cur} ${(c / 100).toFixed(2)}`;
// eslint-disable-next-line no-new-func
const dueRows = new Function('esc', 'money', `${grab('dueRows')}\nreturn dueRows;`)(esc, money);

const base = { currency: 'USD', paymentArrangement: null };

describe('manage page: what is still owed', () => {
  it('pay on the day: cash row, the amount, the team collects — never "Balance due"', () => {
    const out = dueRows({ ...base, paymentArrangement: 'on_the_day' }, 34200);
    expect(out).toContain('To pay on the day (cash, USD)');
    expect(out).toContain('USD 342.00');
    expect(out).toContain('Please pay the Ceylon Hop team in cash at your first pickup.');
    expect(out).not.toContain('Balance due');
    expect(out.toLowerCase()).not.toContain('driver');
  });
  it('an ordinary booking keeps the "Balance due" row and no cash line', () => {
    const out = dueRows(base, 15000);
    expect(out).toContain('Balance due');
    expect(out).toContain('USD 150.00');
    expect(out).not.toContain('Ceylon Hop team');
    expect(out).not.toContain('on the day');
  });
  it('pay on the day with the cash recorded shows nothing', () => {
    expect(dueRows({ ...base, paymentArrangement: 'on_the_day' }, 0)).toBe('');
    expect(dueRows(base, 0)).toBe('');
  });
});
