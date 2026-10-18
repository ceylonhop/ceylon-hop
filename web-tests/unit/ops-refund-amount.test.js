import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

function extract(name) {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found in ops-ui.html`);
  return m[0];
}
// eslint-disable-next-line no-new-func
const parseRefundCents = new Function(`${extract('parseRefundCents')}\nreturn parseRefundCents;`)();
// eslint-disable-next-line no-new-func
const refundIsLate = new Function('tripStartMs', 'REFUND_CUTOFF_MS',
  `${extract('refundIsLate')}\nreturn refundIsLate;`,
)((t) => (t.date ? Date.parse(`${t.date}T${t.time || '00:00'}:00+05:30`) : null), 24 * 3600 * 1000);

describe('parseRefundCents — a typed amount to integer cents, no floating point', () => {
  it.each([['25', 2500], ['25.5', 2550], ['25.50', 2550], ['19.99', 1999], [' $1,200.10 ', 120010], ['0.01', 1]])(
    '%s → %d', (raw, cents) => expect(parseRefundCents(raw)).toBe(cents),
  );
  it.each(['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '.5'])('rejects %j', (raw) => {
    expect(parseRefundCents(raw)).toBeNull();
  });
});

describe('refundIsLate — filed inside the last 24h before the trip', () => {
  const t = { date: '2030-01-15', time: '09:00' }; // 03:30Z; the line is 2030-01-14T03:30Z
  it('is not late a day and a minute out', () => {
    expect(refundIsLate(t, { requestedAt: '2030-01-14T03:29:00.000Z' })).toBe(false);
  });
  it('is late on and after the line', () => {
    expect(refundIsLate(t, { requestedAt: '2030-01-14T03:30:00.000Z' })).toBe(true);
    expect(refundIsLate(t, { requestedAt: '2030-01-16T00:00:00.000Z' })).toBe(true);
  });
  it('is never late without a trip date', () => {
    expect(refundIsLate({ date: null }, { requestedAt: '2030-01-14T03:30:00.000Z' })).toBe(false);
  });
});
