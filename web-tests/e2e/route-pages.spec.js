import { test, expect } from '@playwright/test';

/* The route page used to be a signpost: price CHIPS in the hero, and a "See prices & book"
   CTA that handed the traveller to search.html to do the actual selling. It is now the
   product page — the options and their prices are ON it, and it books directly. */
test('route page renders with nav, both options priced, and books directly', async ({ page }) => {
  await page.goto('/trip/kandy-to-ella/');
  await expect(page.locator('h1')).toContainText('Kandy to Ella');
  // The estimate moved from the hero's prose subtitle into the meta row when the hero
  // became a postcard — same single compact string (#537/#539), stated once, new home.
  await expect(page.locator('.route-hero .route-meta')).toContainText('Approx. 135 km · 3h 45m');
  // "How long does the drive take?" — the first row of the FAQ accordion, which ships open.
  await expect(page.locator('.faq details').first()).toContainText('approx. 135 km · 3h 45m');
  await expect(page.locator('.nav-links')).toBeVisible();

  // private is priced per vehicle, on the page itself
  await expect(page.getByText('$59').first()).toBeVisible();
  await expect(page.getByText('total, fixed').first()).toBeVisible();

  // Kandy -> Ella is not a leg we sell shared, so it says so rather than inventing one.
  // The refusal used to be a grey half-page card (.opt-none); the redesign makes it one
  // line under the trust strip, which is the same statement with honest weight.
  await expect(page.locator('p.no-share')).toBeVisible();

  // ...and the CTA books, rather than forwarding to search
  const cta = page.getByRole('link', { name: /choose date & book/i }).first();
  await expect(cta).toBeVisible();
  await cta.click();
  // Assert where the traveller ENDS UP, not where they pass through. This used to be a bare
  // toHaveURL(/booking\.html/) straight after the click, which polls -- and booking.html's
  // URL exists for a few ms before booking.js redirects. It matched that flicker and passed
  // for the whole time the CTA was broken (it landed on plan.html). Waiting for the page to
  // settle first is what makes this able to fail.
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/booking\.html\?.*from=kandy.*to=ella/);
  await expect(page).not.toHaveURL(/plan\.html/);
  // and it arrives priced, rather than as a bare from/to booking.js cannot resolve
  expect(new URL(page.url()).searchParams.get('mode')).toBe('private');
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
  await expect(page.locator('h1')).toContainText('Sri Lanka shared taxi & transfer routes');
  const card = page.getByRole('link', { name: /Kandy → Ella/ }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Approx. 135 km · 3h 45m');
  await card.click();
  await expect(page).toHaveURL(/\/trip\/kandy-to-ella\/?$/);
});

test('compact route estimates stay readable without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/trip/kandy-to-ella/');

  await expect(page.locator('.route-hero .route-meta')).toContainText('Approx. 135 km · 3h 45m');
  await expect(page.locator('.rt-card').first()).toContainText('Approx. 135 km · 3h 45m');
  expect(await page.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

/* The live date rows are injected by route-page.js onto a page that sits TWO directories
   deep (/trip/<slug>/), so a bare "board.html#/CODE" href resolved against the trip page's
   own folder and every row landed on a 404. The static CTA beside them has always been
   written "../../board.html" — these rows must reach the same place. */
test('a live ride row links to the board, not to a 404 under /trip/', async ({ page }) => {
  await page.route(
    (u) => new URL(u.href).pathname === '/board',
    (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        lists: [{
          code: 'NS-1234', corridorId: 'airport-north', from: 'Negombo', to: 'Sigiriya / Dambulla',
          date: '2099-01-01', slot: 'morning', lockedTime: null, minSeats: 3, capacity: 6,
          seatPrice: 2749, status: 'gathering', note: null,
          cutoffAt: '2099-01-01T00:00:00.000Z', committed: 2,
          members: [{ position: 1, firstName: 'Ana', country: 'DE', photoUrl: null, isStarter: true }],
        }],
      }),
    }),
  );

  await page.goto('/trip/negombo-to-sigiriya/');
  const row = page.locator('.ld-row').first();
  await expect(row).toBeVisible();
  expect(new URL(await row.evaluate((a) => a.href)).pathname).toBe('/board.html');

  await row.click();
  await expect(page).toHaveURL(/\/board\.html#\/NS-1234$/);
});
