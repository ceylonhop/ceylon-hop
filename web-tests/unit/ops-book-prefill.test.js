// The "Mark booked" modal pre-fills from what the customer typed on the pay page (the quote's
// converted booking), falling back to the quote's own fields (2026-10-29). Pure function, so
// extracted from ops-ui.html and evaluated here like ops-book-error-text.test.js.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { futureIsoDate } from '../dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
const m = html.match(/function bookPrefill\(st, booking\) \{[\s\S]*?\n\}/);
if (!m) throw new Error('bookPrefill not found in ops-ui.html');
// eslint-disable-next-line no-new-func
const bookPrefill = new Function('isValidEmail', 'isValidPhone', 'return (' + m[0] + ')')(
  (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), (s) => /^\+?[\d\s-]{7,}$/.test(s));

const DATE = futureIsoDate(30);
const st = { firstName: 'Lena', lastName: '', contact: '+49 151 0000 0000', legs: [{ date: DATE }] };
const booking = { input: { customer: { firstName: 'Lena', lastName: 'Weber', email: 'lena.weber@example.com',
  whatsapp: '+4915100000000', country: 'Germany' } } };

describe('bookPrefill', () => {
  it('prefers what the customer typed on the pay page', () => {
    expect(bookPrefill(st, booking)).toEqual({ first: 'Lena', last: 'Weber', email: 'lena.weber@example.com',
      whatsapp: '+4915100000000', country: 'Germany', date: DATE });
  });
  it('falls back to the quote when there is no booking', () => {
    expect(bookPrefill(st, null)).toEqual({ first: 'Lena', last: '', email: '',
      whatsapp: '+49 151 0000 0000', country: '', date: DATE });
  });
  it('never blanks a quote value with an empty booking value', () => {
    const b = { input: { customer: { firstName: '', lastName: 'Weber', email: '', whatsapp: '', country: '' } } };
    expect(bookPrefill(st, b).first).toBe('Lena');
  });
});

// The fetch is awaited before the modal opens. If the operator opens another quote meanwhile, the
// modal must not open there pre-filled with THIS customer (confirming would book the wrong person):
// the file's _openSeq guard has to sit between the await and the writes.
describe('openBookModal', () => {
  const src = (html.match(/async function openBookModal\(\) \{[\s\S]*?\n\}/) || [''])[0];
  it('bails when a different quote opened while the booking fetch was in flight', () => {
    const fetchAt = src.indexOf("await api('/admin/ops/bookings/'");
    const guardAt = src.indexOf('if (seq !== _openSeq) return;');
    expect(src.indexOf('var seq = _openSeq;')).toBeGreaterThan(-1);
    expect(src.indexOf('var seq = _openSeq;')).toBeLessThan(fetchAt);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(fetchAt);
    expect(guardAt).toBeLessThan(src.indexOf('bookPrefillBooking = body'));
    expect(guardAt).toBeLessThan(src.indexOf('bookOpen = true'));
  });
});
