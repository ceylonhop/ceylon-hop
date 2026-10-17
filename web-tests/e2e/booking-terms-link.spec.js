import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// The terms checkbox on booking.html's last step (owner, 2026-10-15: "Checkout page not linking to
// terms"). The <a> was always in the markup, but site.css's global `a{color:inherit;text-decoration:none}`
// painted it the same grey as the sentence around it, so nobody could tell it was a link. pay.html
// already styles its own (.dt-terms a); this pins booking.html to the same treatment.

test.describe('the terms link at checkout', () => {
  test('reads as a link: accent colour, underlined, distinct from the sentence', async ({ page }) => {
    await gotoBooking(page);
    await fillContact(page);
    const link = page.locator('.terms-consent a[href="terms.html#refunds"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Terms & cancellation policy');
    const look = await link.evaluate((a) => {
      const s = getComputedStyle(a), p = getComputedStyle(a.parentElement);
      return { color: s.color, parent: p.color, line: s.textDecorationLine };
    });
    expect(look.color).not.toBe(look.parent);
    expect(look.line).toContain('underline');
  });

  test('a tap opens the terms in a new tab and does not tick the box', async ({ page, context }) => {
    await gotoBooking(page);
    await fillContact(page);
    await page.uncheck('#agree'); // fillContact ticks it; start from unticked
    await context.route('**/terms.html*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1 id="refunds">Terms</h1>' }));
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.terms-consent a[href="terms.html#refunds"]').click(),
    ]);
    await expect.poll(() => tab.url()).toContain('/terms.html#refunds');
    await expect(page.locator('#agree')).not.toBeChecked();
  });
});
