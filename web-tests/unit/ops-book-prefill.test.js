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
const st = { firstName: 'Sandy', lastName: '', contact: '+49 1515 642 4312', legs: [{ date: DATE }] };
const booking = { input: { customer: { firstName: 'Sandy', lastName: 'Schwarz', email: 'sandy@ts-schwarz.de',
  whatsapp: '+4915156424312', country: 'Germany' } } };

describe('bookPrefill', () => {
  it('prefers what the customer typed on the pay page', () => {
    expect(bookPrefill(st, booking)).toEqual({ first: 'Sandy', last: 'Schwarz', email: 'sandy@ts-schwarz.de',
      whatsapp: '+4915156424312', country: 'Germany', date: DATE });
  });
  it('falls back to the quote when there is no booking', () => {
    expect(bookPrefill(st, null)).toEqual({ first: 'Sandy', last: '', email: '',
      whatsapp: '+49 1515 642 4312', country: '', date: DATE });
  });
  it('never blanks a quote value with an empty booking value', () => {
    const b = { input: { customer: { firstName: '', lastName: 'Schwarz', email: '', whatsapp: '', country: '' } } };
    expect(bookPrefill(st, b).first).toBe('Sandy');
  });
});
