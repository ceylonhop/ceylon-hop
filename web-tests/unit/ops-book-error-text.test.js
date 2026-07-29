import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// bookErrorText lives inside the served ops-ui.html and is fully self-contained, so
// extract it by its source markers and evaluate it directly — same trick as
// ops-route-note.test.js. Guards the message an operator actually reads when
// "Mark booked" is rejected: it used to say only "Could not book — bad_request",
// naming no field, which cost a support round trip to diagnose a mistyped email.
function loadBookErrorText() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const m = html.match(/function bookErrorText\(res\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('bookErrorText not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}

const bookErrorText = loadBookErrorText();

describe('ops "Mark booked" error message', () => {
  it('names the field from the server message', () => {
    expect(bookErrorText({
      error: 'bad_request',
      message: 'customer.email: Invalid email',
      details: { fieldErrors: { customer: ['Invalid email'] }, formErrors: [] },
    })).toBe('Could not book — customer.email: Invalid email');
  });

  it('lists several bad fields rather than only the first', () => {
    const txt = bookErrorText({
      error: 'bad_request',
      message: 'customer.email: Invalid email; pax: Number must be greater than or equal to 1',
    });
    expect(txt).toContain('customer.email');
    expect(txt).toContain('pax');
  });

  it('falls back to flattened details when no message is present', () => {
    expect(bookErrorText({
      error: 'bad_request',
      details: { fieldErrors: { customer: ['Invalid email'] }, formErrors: [] },
    })).toBe('Could not book — customer: Invalid email');
  });

  it('still says something useful for a plain error with no detail', () => {
    expect(bookErrorText({ error: 'not_bookable' })).toBe('Could not book — not_bookable');
    expect(bookErrorText({ error: 'Network error' })).toBe('Could not book — Network error');
  });

  it('handles a missing response without throwing', () => {
    expect(bookErrorText(null)).toBe('Could not book — unknown error');
    expect(bookErrorText({})).toBe('Could not book — unknown error');
  });
});
