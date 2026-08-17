import { test, expect } from '@playwright/test';

/* The route page used to be a signpost: price CHIPS in the hero, and a "See prices & book"
   CTA that handed the traveller to search.html to do the actual selling. It is now the
   product page — the options and their prices are ON it, and it books directly. */
test('route page renders with nav, both options priced, and books directly', async ({ page }) => {
  await page.goto('/trip/kandy-to-ella/');
  await expect(page.locator('h1')).toContainText('Kandy to Ella');
  await expect(page.locator('.nav-links')).toBeVisible();

  // private is priced per vehicle, on the page itself
  await expect(page.getByText('$59').first()).toBeVisible();
  await expect(page.getByText('total, fixed').first()).toBeVisible();

  // Kandy -> Ella is not a leg we sell shared, so it says so rather than inventing one
  await expect(page.locator('.opt-none')).toBeVisible();

  // ...and the CTA books, rather than forwarding to search
  const cta = page.getByRole('link', { name: /book private transfer/i }).first();
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page).toHaveURL(/booking\.html\?from=kandy&to=ella/);
});

test('a route we DO sell shared states the seat price and its boarding points', async ({ page }) => {
  await page.goto('/trip/negombo-to-sigiriya/');
  const shared = page.locator('.opt-shared');
  await expect(shared).toBeVisible();
  // scoped to the card: the price also appears in the title and the FAQ
  await expect(shared.locator('.seat-price')).toContainText('$27.49');
  await expect(shared.getByText(/Runs once 3 travellers are going/)).toBeVisible();
  await expect(shared.getByText('Zen Cafe, Negombo')).toBeVisible();
  // design A: no timetable language anywhere on the page
  await expect(page.getByText(/scheduled|Wed & Sat/i)).toHaveCount(0);
});

test('/trip/ index lists route cards that link to pages', async ({ page }) => {
  await page.goto('/trip/');
  await expect(page.locator('h1')).toContainText('Sri Lanka transfer routes');
  const card = page.getByRole('link', { name: /Kandy → Ella/ }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/trip\/kandy-to-ella\/?$/);
});
