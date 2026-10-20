import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// Owner 2026-09-28: the Bookings queue gets two views — by travel date (the day groups) and
// "Recently booked" (newest first, everything) — plus a product-type filter: private transfers
// (A→B and private multi-stop trips), chauffeur guide, shared ride, ride board. The helpers are
// pure arrow consts inside ops-ui.html; extract and eval them, as ops-day-groups.test.js does,
// so this tests the REAL page code.
function extractConst(name) {
  const start = html.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`const ${name} not found in ops-ui.html`);
  const open = html.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    if (depth === 0) break;
  }
  return html.slice(html.indexOf('=', start) + 1, i + 1);
}

const CLOSED = ['completed', 'no_show', 'cancelled', 'refunded'];
const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const TODAY = iso(0);
const TOMORROW = iso(1);

// eslint-disable-next-line no-new-func
const { productType, byRecent, inQueue } = new Function('CLOSED', 'TODAY', 'TOMORROW', `
  const isExpired=${extractConst('isExpired')};
  const isOverdue=${extractConst('isOverdue')};
  const inGroup=${extractConst('inGroup')};
  const productType=${extractConst('productType')};
  const byRecent=${extractConst('byRecent')};
  const inQueue=${extractConst('inQueue')};
  return { productType, byRecent, inQueue };
`)(CLOSED, TODAY, TOMORROW);

const t = (over) => ({ stage: 'paid', date: iso(20), mode: 'single', chan: 'website', serviceType: null, ...over });

describe('bookings queue product type', () => {
  it('files an A→B transfer and a private multi-stop trip under private transfers', () => {
    expect(productType(t({ mode: 'single' }))).toBe('private');
    expect(productType(t({ mode: 'trip', serviceType: 'private' }))).toBe('private');
  });

  it('files a chauffeur-guide trip on its own', () => {
    expect(productType(t({ mode: 'trip', serviceType: 'chauffeur' }))).toBe('chauffeur');
  });

  it('keeps shared seats and ride-board vans apart', () => {
    expect(productType(t({ mode: 'shared' }))).toBe('shared');
    expect(productType(t({ mode: 'board' }))).toBe('board');
  });

  it('treats a trip stored without a service type as a private car, never a chauffeur', () => {
    expect(productType(t({ mode: 'trip', serviceType: undefined }))).toBe('private');
  });
});

describe('bookings queue views', () => {
  const s = (over) => ({ view: 'date', group: 'all', chan: '', type: '', ...over });

  it('"Recently booked" shows everything — closed, expired and needs-closing rows included', () => {
    const rows = [
      t({ stage: 'completed' }),
      t({ stage: 'cancelled' }),
      t({ stage: 'awaiting_payment', date: iso(-3) }), // expired
      t({ stage: 'paid', date: iso(-3) }), // needs closing
      t({ stage: 'paid' }),
    ];
    expect(rows.filter((r) => inQueue(r, s({ view: 'recent' })))).toHaveLength(5);
    // …whereas by travel date, "All open" keeps only the forward work.
    expect(rows.filter((r) => inQueue(r, s()))).toHaveLength(1);
  });

  it('"Recently booked" ignores the stage chip it was left on', () => {
    expect(inQueue(t({ stage: 'completed' }), s({ view: 'recent', group: 'pay' }))).toBe(true);
  });

  it('applies the type and channel filters in both views', () => {
    const chauffeur = t({ mode: 'trip', serviceType: 'chauffeur', chan: 'whatsapp' });
    for (const view of ['date', 'recent']) {
      expect(inQueue(chauffeur, s({ view, type: 'chauffeur' }))).toBe(true);
      expect(inQueue(chauffeur, s({ view, type: 'private' }))).toBe(false);
      expect(inQueue(chauffeur, s({ view, chan: 'website' }))).toBe(false);
    }
  });

  it('orders newest booking first, rows without a time last', () => {
    const rows = [
      { id: 'old', created: '2026-09-01T08:00:00Z' },
      { id: 'none', created: null },
      { id: 'new', created: '2026-09-27T21:15:00Z' },
      { id: 'mid', created: '2026-09-20T10:00:00.000Z' },
    ];
    expect(rows.sort(byRecent).map((r) => r.id)).toEqual(['new', 'mid', 'old', 'none']);
  });
});
