import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Owner, 2026-09-23: customers ask about refunds before they book. The results page only said
// "Free cancellation" in a strip BELOW the results — the cards, where the choice is made, said
// nothing. Private transfers and shared seats share one window (terms.html §7): 24 hours.
// Negombo → Sigiriya sells a scheduled seat (see search-shared-by-day.spec.js), so both cards show.
test('each bookable option on the results page states its free-cancellation window', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=negombo&to=sigiriya&pax=2' });
  await expect(page.locator('#results .opt-private').first()).toContainText('Free cancellation up to 24h before');

  const shared = page.locator('#shared-option');
  await expect(shared.getByRole('link', { name: /Book a seat/ })).toBeVisible();
  await expect(shared).toContainText('Free cancellation up to 24h before');
});
