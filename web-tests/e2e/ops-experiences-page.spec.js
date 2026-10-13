import { test, expect } from '@playwright/test';

// Experiences page, Catalogue tab (spec 2026-10-06 D14): ops maintains the partner-experience
// catalogue here. Offline: whoami, the queue and /admin/experiences are stubbed (the API's own
// rules are covered by api's opsExperiences.test.ts). Modelled on ops-rates-page.spec.js.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const FOUNDER = ['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'payments:reverse', 'analytics:view', 'experiences:manage'];
const OPS = ['quote:manage', 'quote:approve_simple', 'bookings:operate', 'bookings:read', 'experiences:manage'];
const FINANCE = ['quote:manage', 'bookings:read', 'payments:act'];

// The three Sigiriya placeholders (api/src/experiences/placeholders.ts) in the GET /admin/experiences shape.
const stamp = { currency: 'USD', createdBy: 'x', updatedBy: null, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' };
const EXPERIENCES = [
  { ...stamp, id: '11111111-1111-4111-8111-111111111111', slug: 'placeholder-ayurvedic-massage', name: 'Ayurvedic massage', partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
    summary: 'A 90-minute Ayurvedic massage with herbal oils.', details: 'PLACEHOLDER for staging tests.', priceCents: 3500, priceUnit: 'per_person', durationText: '90 min',
    openWeekdays: [0, 1, 2, 3, 4, 5, 6], startTimes: ['09:00', '11:00', '14:00', '16:00'], lat: 7.977, lng: 80.76, radiusKm: 5, photos: ['guides/sigiriya/ayurveda'], partnerContact: null, active: true },
  { ...stamp, id: '22222222-2222-4222-8222-222222222222', slug: 'placeholder-village-cooking-lesson', name: 'Village cooking lesson', partnerName: 'Suwee', areaLabel: 'Sigiriya',
    summary: 'Cook a Sri Lankan village meal with a local family.', details: 'PLACEHOLDER.', priceCents: 2500, priceUnit: 'per_person', durationText: '3 hrs',
    openWeekdays: [1, 2, 3, 4, 5, 6], startTimes: ['10:00', '16:00'], lat: 7.95, lng: 80.796, radiusKm: 5, photos: ['guides/sigiriya/family-food', 'guides/sigiriya/village'], partnerContact: null, active: true },
  { ...stamp, id: '33333333-3333-4333-8333-333333333333', slug: 'placeholder-elephant-jeep-safari', name: 'Elephant jeep safari', partnerName: 'Sample jeep partner', areaLabel: 'Sigiriya',
    summary: 'A jeep safari to see wild elephants.', details: 'PLACEHOLDER.', priceCents: 4500, priceUnit: 'per_group', durationText: '3-4 hrs',
    openWeekdays: [0, 1, 2, 3, 4, 5, 6], startTimes: ['14:00'], lat: 7.92, lng: 80.81, radiusKm: 10, photos: ['guides/sigiriya/elephants'], partnerContact: null, active: true },
];
const STATS = [{ experienceId: EXPERIENCES[0].id, interested: 3, paid: 1, paidCents: { USD: 3500, LKR: 0 } }];

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Boots the shell with `caps` and a mutable stub catalogue. `calls` records every write.
async function boot(page, caps, { list, post, patch } = {}) {
  const db = EXPERIENCES.map((e) => ({ ...e }));
  const calls = { get: 0, post: [], patch: [] };
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}),
      },
    };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  // A photo whose stem contains "live" exists on the site; every other one is "not live yet".
  await page.route('https://ceylonhop.com/img/**', (r) =>
    (r.request().url().includes('live') ? r.fulfill({ status: 200, contentType: 'image/gif', body: GIF }) : r.abort()));
  await page.route('**/admin/experiences', async (r) => {
    const req = r.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      calls.post.push(body);
      if (post) return post(r, body);
      const e = { ...stamp, id: '44444444-4444-4444-8444-444444444444', ...body };
      db.push(e);
      return r.fulfill(json({ experience: e }, 201));
    }
    calls.get++;
    if (list) return list(r, db);
    return r.fulfill(json({ experiences: db, stats: STATS }));
  });
  await page.route('**/admin/experiences/*', async (r) => {
    const req = r.request();
    const id = req.url().split('/').pop();
    const body = req.postDataJSON();
    calls.patch.push({ id, body });
    if (patch) return patch(r, body);
    const e = db.find((x) => x.id === id);
    Object.assign(e, body);
    return r.fulfill(json({ experience: e }));
  });
  return calls;
}
const ready = (page) => page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
const expPage = (page) => page.locator('[data-testid="experiences-page"]');
const rows = (page) => expPage(page).locator('[data-testid="exp-row"]');

// A form that would save: every required field filled, the pin valid unless a test overrides it.
async function fillValid(page, { loc = '7.977, 80.76' } = {}) {
  await page.locator('#exp-slug').fill('test-sunrise-hike');
  await page.locator('#exp-name').fill('Sunrise hike');
  await page.locator('#exp-partner').fill('Hill Guides');
  await page.locator('#exp-area').fill('Ella');
  await page.locator('#exp-summary').fill('Walk up for the sunrise.');
  await page.locator('#exp-price').fill('35.50');
  await page.locator('#exp-loc').fill(loc);
}

test('founder and ops see the Experiences nav; finance does not', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#bookings');
  await ready(page);
  const nav = page.locator('[data-testid="experiences-nav"]');
  await expect(nav).toBeVisible();
  await expect(nav).toHaveAttribute('title', 'Experiences');

  const ops = await page.context().newPage();
  await boot(ops, OPS);
  await ops.goto(OPS_FILE + '#bookings');
  await ready(ops);
  await expect(ops.locator('[data-testid="experiences-nav"]')).toBeVisible();

  const fin = await page.context().newPage();
  const calls = await boot(fin, FINANCE);
  await fin.goto(OPS_FILE + '#experiences');
  await ready(fin);
  await expect(fin.locator('[data-testid="experiences-nav"]')).toHaveCount(0);
  await expect(expPage(fin)).toHaveCount(0);
  expect(new URL(fin.url()).hash).not.toBe('#experiences');
  expect(calls.get).toBe(0);
});

test('the list shows the three placeholders with price, days, status and stats', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#bookings');
  await ready(page);
  await page.locator('[data-testid="experiences-nav"]').click();
  await expect(page.locator('#view h1')).toHaveText('Experiences');
  expect(new URL(page.url()).hash).toBe('#experiences');
  await expect(rows(page)).toHaveCount(3);

  const massage = rows(page).nth(0);
  await expect(massage).toContainText('Ayurvedic massage');
  await expect(massage).toContainText('Atherya Spa');
  await expect(massage).toContainText('Sigiriya');
  await expect(massage).toContainText('$35 pp');
  await expect(massage).toContainText('5 km');
  await expect(massage).toContainText('Daily');
  await expect(massage).toContainText('3 interested');
  await expect(massage).toContainText('1 paid');
  await expect(massage).toContainText('$35');
  await expect(massage.locator('img')).toHaveAttribute('src', 'https://ceylonhop.com/img/guides/sigiriya/ayurveda-900.jpg');
  await expect(massage.locator('[data-action="expToggle"]')).toBeChecked();

  await expect(rows(page).nth(1)).toContainText('Closed Sun');
  await expect(rows(page).nth(2)).toContainText('$45 per group');
  await expect(rows(page).nth(2)).toContainText('10 km');
  await expect(rows(page).nth(2)).toContainText('0 interested');
});

test('a hand-typed #experiences opens the page directly', async ({ page }) => {
  await boot(page, OPS);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await expect(page.locator('#view h1')).toHaveText('Experiences');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('[data-testid="experiences-nav"]')).toHaveClass(/active/);
});

test('create: the POST carries cents, weekdays, times and photos, and the row appears', async ({ page }) => {
  const calls = await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await expect(rows(page)).toHaveCount(3);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page);
  await page.locator('#exp-unit').selectOption('per_group');
  await page.locator('#exp-duration').fill('2 hrs');
  for (const d of [0, 4, 5, 6]) await page.locator('#exp-day-' + d).uncheck(); // a new form starts Daily
  await page.locator('#exp-times').fill('14:30, 06:00');
  await page.locator('#exp-photo-0').fill('experiences/test-sunrise-hike/a');
  await page.locator('#exp-radius').fill('8');
  await page.locator('[data-action="expSave"]').click();

  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(3)).toContainText('Sunrise hike');
  await expect(rows(page).nth(3)).toContainText('$35.50 per group');
  expect(calls.post).toEqual([{
    slug: 'test-sunrise-hike', name: 'Sunrise hike', partnerName: 'Hill Guides', areaLabel: 'Ella',
    summary: 'Walk up for the sunrise.', details: '', priceCents: 3550, priceUnit: 'per_group', durationText: '2 hrs',
    openWeekdays: [1, 2, 3], startTimes: ['06:00', '14:30'], lat: 7.977, lng: 80.76, radiusKm: 8,
    photos: ['experiences/test-sunrise-hike/a'], partnerContact: null, active: true,
  }]);
  await expect(page.locator('#exp-form')).toHaveCount(0);
});

test('edit: the form opens with the saved values and saves with PATCH', async ({ page }) => {
  const calls = await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await rows(page).nth(1).locator('[data-action="expEdit"]').click();
  await expect(page.locator('#exp-name')).toHaveValue('Village cooking lesson');
  await expect(page.locator('#exp-price')).toHaveValue('25');
  await expect(page.locator('#exp-loc')).toHaveValue('7.95, 80.796');
  await expect(page.locator('#exp-day-0')).not.toBeChecked();
  await expect(page.locator('#exp-day-1')).toBeChecked();
  await expect(page.locator('#exp-times')).toHaveValue('10:00, 16:00');
  await expect(page.locator('#exp-photo-1')).toHaveValue('guides/sigiriya/village');
  await page.locator('#exp-name').fill('Village cooking class');
  await page.locator('[data-action="expSave"]').click();
  await expect(rows(page).nth(1)).toContainText('Village cooking class');
  expect(calls.patch).toHaveLength(1);
  expect(calls.patch[0].id).toBe(EXPERIENCES[1].id);
  expect(calls.patch[0].body).toMatchObject({ name: 'Village cooking class', priceCents: 2500, openWeekdays: [1, 2, 3, 4, 5, 6], lat: 7.95, lng: 80.796 });
});

test('a "lng, lat" paste shows the Sri Lanka error and sends nothing', async ({ page }) => {
  const calls = await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page, { loc: '80.76, 7.977' });
  await expect(page.locator('[data-testid="exp-loc-error"]')).toContainText('Sri Lanka');
  await page.locator('[data-action="expSave"]').click();
  await expect(page.locator('[data-testid="exp-loc-error"]')).toBeVisible();
  expect(calls.post).toHaveLength(0);

  await page.locator('#exp-loc').fill('not a place');
  await expect(page.locator('[data-testid="exp-loc-error"]')).toContainText('lat');
  await page.locator('#exp-loc').fill('7.977, 80.76');
  await expect(page.locator('[data-testid="exp-loc-error"]')).toHaveCount(0);
});

test('a Google Maps URL fills lat/lng and the check link', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await page.locator('#exp-loc').fill('https://www.google.com/maps/place/Sigiriya/@7.957,80.7598,15z/data=!3m1!4b1');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toContainText('7.957');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toContainText('80.7598');
  await expect(page.locator('[data-testid="exp-loc-check"]')).toHaveAttribute('href', /7\.957,80\.7598/);
  await expect(page.locator('[data-testid="exp-loc-check"]')).toHaveText(/Open in Google Maps/);

  await page.locator('#exp-loc').fill('https://maps.google.com/?q=7.977,80.76');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toContainText('7.977');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toContainText('80.76');
});

test('photo previews: a missing image says it is not live yet', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await page.locator('#exp-photo-0').fill('experiences/test-hike/new-photo');
  await expect(page.locator('[data-testid="exp-photo-note"]').first()).toContainText('Not live yet — photos appear after the site promote');
  await page.locator('#exp-photo-1').fill('experiences/test-hike/live-photo');
  await expect(page.locator('#exp-photo-1-prev img')).toHaveAttribute('src', 'https://ceylonhop.com/img/experiences/test-hike/live-photo-900.jpg');
  await expect(page.locator('#exp-photo-1-prev [data-testid="exp-photo-note"]')).toBeHidden();
});

test('toggling Active sends PATCH {active:false}', async ({ page }) => {
  const calls = await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await rows(page).nth(0).locator('[data-action="expToggle"]').uncheck();
  await expect.poll(() => calls.patch.length).toBe(1);
  expect(calls.patch[0]).toEqual({ id: EXPERIENCES[0].id, body: { active: false } });
  await expect(rows(page).nth(0).locator('[data-action="expToggle"]')).not.toBeChecked();
});

test('a taken slug shows "That slug is taken" on the slug field', async ({ page }) => {
  await boot(page, FOUNDER, { post: (r) => r.fulfill(json({ error: 'slug_taken' }, 409)) });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page);
  await page.locator('[data-action="expSave"]').click();
  await expect(page.locator('[data-err="slug"]')).toHaveText('That slug is taken');
  await expect(page.locator('#exp-form')).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
});

test('400 issues are mapped onto their fields', async ({ page }) => {
  await boot(page, FOUNDER, {
    post: (r) => r.fulfill(json({ error: 'bad_request', issues: [
      { path: ['name'], message: 'String must contain at most 80 character(s)' },
      { path: ['photos', 0], message: 'use a path under img/, e.g. experiences/slug/name' },
    ] }, 400)),
  });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page);
  await page.locator('#exp-photo-0').fill('Bad Path');
  await page.locator('[data-action="expSave"]').click();
  await expect(page.locator('[data-err="name"]')).toContainText('at most 80');
  await expect(page.locator('[data-err="photos"]')).toContainText('use a path under img/');
});

test('values are escaped: a name with markup renders as text', async ({ page }) => {
  await boot(page, FOUNDER, {
    list: (r, db) => r.fulfill(json({ experiences: [{ ...db[0], name: '<img src=x onerror=window.__pwned=1>', partnerName: 'A "B" & C' }], stats: [] })),
  });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await expect(rows(page).first()).toContainText('<img src=x onerror=window.__pwned=1>');
  await expect(rows(page).first()).toContainText('A "B" & C');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('a list that lands after leaving the page paints nothing', async ({ page }) => {
  let release;
  const gate = new Promise((res) => { release = res; });
  await boot(page, FOUNDER, { list: async (r, db) => { await gate; return r.fulfill(json({ experiences: db, stats: [] })); } });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await expect(page.locator('#view h1')).toHaveText('Experiences');
  await page.locator('#nav [data-route="tickets"]').click();
  await expect(page.locator('#view h1')).toHaveText('Bookings');

  const landed = page.waitForResponse((res) => res.url().includes('/admin/experiences'));
  release();
  await landed;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await expect(expPage(page)).toHaveCount(0);
  await expect(page.locator('#view h1')).toHaveText('Bookings');
});
