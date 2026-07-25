import { test, expect } from '@playwright/test';

// Trip-basics ribbon: the traveller pills replaced the old #pax select. These pin the
// behaviours that used to flow through the select — the pax gate, the >3-travellers
// car lock + van auto-switch, and URL/template hand-offs pre-lighting a pill.

test('fresh planner is gated until a traveller pill is picked', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html');

  await expect(page.locator('#itin-gate')).toBeVisible();
  await expect(page.locator('#rail')).toBeHidden();

  await page.locator('.pax-pill[data-pax="2"]').click();

  await expect(page.locator('.pax-pill[data-pax="2"]')).toHaveClass(/on/);
  await expect(page.locator('.pax-pill[data-pax="2"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#itin-gate')).toBeHidden();
  // A fresh planner carries no seed route, so the opened board shows the empty state rather
  // than leg cards — #rail is present but has no size until a leg exists.
  await expect(page.locator('#rail-empty')).toBeVisible();
});

test('a fresh planner opens empty — no transfers the customer did not add', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html');

  await page.locator('.pax-pill[data-pax="3"]').click();

  // The bug this guards: plan.html used to fall back to a hardcoded CMB|Sigiriya|Ella route,
  // so picking a traveller count appeared to conjure two priced transfers from nowhere.
  await expect(page.locator('#rail .leg-card')).toHaveCount(0);
  await expect(page.locator('#rail-empty')).toBeVisible();
  await expect(page.locator('#add-stop')).toContainText('Add your first transfer');
  await expect(page.locator('#stop-count')).toHaveText('');
  // ...and nothing fake is written back into the URL.
  expect(new URL(page.url()).searchParams.get('stops')).toBeNull();

  await page.locator('#add-stop').click();

  await expect(page.locator('#rail .leg-card')).toHaveCount(1);
  await expect(page.locator('#rail-empty')).toBeHidden();
  await expect(page.locator('#add-stop')).toContainText('Add another transfer');
});

test('picking more than 3 travellers locks the car and switches to the van', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html');

  await page.locator('.pax-pill[data-pax="5"]').click();

  await expect(page.locator('.veh-btn[data-veh="car"]')).toBeDisabled();
  await expect(page.locator('.veh-btn[data-veh="van"]')).toHaveClass(/on/);
  await expect(page.locator('#veh-note')).toBeVisible();
  await expect(page.locator('#veh-note-tx')).toContainText('5 travellers need a van');

  // dropping back to 3 unlocks the car again (van stays selected — no silent switch back)
  await page.locator('.pax-pill[data-pax="3"]').click();
  await expect(page.locator('.veh-btn[data-veh="car"]')).toBeEnabled();
  await expect(page.locator('#veh-note')).toBeHidden();
});

test('a booking/template hand-off pre-lights the matching pill', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=4&vehicle=van');

  await expect(page.locator('.pax-pill[data-pax="4"]')).toHaveClass(/on/);
  await expect(page.locator('.pax-pill.on')).toHaveCount(1);
  await expect(page.locator('#itin-gate')).toBeHidden();
  // pax=4 also means the car is locked on arrival
  await expect(page.locator('.veh-btn[data-veh="car"]')).toBeDisabled();
});
