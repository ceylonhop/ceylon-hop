import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extract the booking sheet's promo line from ops-ui.html by source markers (the same trick as
// ops-booking-addons.test.js), handing it the page's own money() so the figure is the real one.
function load() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const fn = html.match(/function bookingPromo\(booking\) \{[\s\S]*?\n\}/);
  const money = html.match(/const money=(t=>\{[^\n]*\});/);
  if (!fn || !money) throw new Error('bookingPromo(booking) or money not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('money', 'return (' + fn[0] + ')')(new Function('return ' + money[1])());
}
const bookingPromo = load();

// The Promo row in the ops booking sheet's Payment block: which code, and what it took off.
describe('booking sheet promo code', () => {
  it('names the code and the discount', () => {
    expect(bookingPromo({ promoCode: 'SUMMER-15', discountTotal: 670, currency: 'USD' })).toBe('SUMMER-15 · −$6.70');
  });

  it('is empty on a booking without a code', () => {
    expect(bookingPromo({ currency: 'USD' })).toBe('');
    expect(bookingPromo({ promoCode: 'SUMMER-15', discountTotal: 0, currency: 'USD' })).toBe('');
    expect(bookingPromo(undefined)).toBe('');
  });
});
