import { test, expect } from '@playwright/test';

// A discontinuous itinerary (a leg's drop-off ≠ the next leg's pick-up) is the traveller's
// choice — they'll arrange that stretch themselves (a train, their own transport). The planner
// must NOT invent a connector leg for the gap, the booking hand-off must not price/charge it,
// and returning to the planner must not grow a leg the traveller never created. The gap is
// shown (a note in the planner, a self-arranged marker on the booking page) but never billed.

async function buildDiscontinuous(page) {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla%7CMirissa&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  // Break continuity: leg 2 becomes Galle→Mirissa (was Ella→Mirissa). Now Ella≠Galle is a gap.
  const leg2From = page.locator('#rail .leg-card').nth(1).locator('.leg-from');
  await leg2From.click();
  await leg2From.fill('Galle');
  await expect(page.locator('.place-menu')).toBeVisible();
  await page.locator('.place-option', { hasText: 'Galle' }).first().click();
}

test('the planner flags a gap and never invents a connector leg', async ({ page }) => {
  await buildDiscontinuous(page);
  // Exactly the two legs the traveller created — no auto-inserted Ella→Galle.
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  // The gap between the mismatched legs is flagged.
  await expect(page.locator('.leg-gap.is-gap')).toBeVisible();
});

test('a gap is carried to booking, shown as self-arranged, never priced as a leg', async ({ page }) => {
  await buildDiscontinuous(page);
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  const q = new URL(page.url()).searchParams;
  expect(q.get('gaps')).toBe('1'); // wire 1 (Ella→Galle) is the gap

  // Two real, numbered legs + one self-arranged gap marker — NOT a third priced leg.
  await expect(page.locator('.tr-leg-badge')).toHaveCount(2);
  await expect(page.locator('.tr-gap')).toHaveCount(1);
});

test('editing back from booking restores the original legs, no connector', async ({ page }) => {
  await buildDiscontinuous(page);
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  await page.locator('.tr-edit').click();
  await page.waitForURL('**/plan.html?**');
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await expect(page.locator('.leg-gap.is-gap')).toBeVisible();
});

test('the reference map breaks the route line at the gap (no line drawn across it)', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  // Load the discontinuous itinerary directly: Kandy→Ella, [gap], Galle→Mirissa.
  await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella|Galle|Mirissa') + '&gaps=1&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  // Two drawn segments (Kandy→Ella and Galle→Mirissa); the Ella→Galle gap is NOT connected.
  await expect(page.locator('#trip-map .tm-route')).toHaveCount(2);
});
