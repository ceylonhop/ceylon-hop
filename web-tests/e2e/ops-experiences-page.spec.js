import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

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
async function boot(page, caps, { list, post, patch, leads, patchLead, confirmLead } = {}) {
  const db = EXPERIENCES.map((e) => ({ ...e }));
  const leadDb = (leads || []).map((l) => ({ ...l }));
  const calls = { get: 0, post: [], patch: [], leadsGet: 0, leadPatch: [], confirm: [] };
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
  // Registered AFTER the single-segment route above: Playwright gives precedence to the last match.
  await page.route('**/admin/experiences/leads', (r) => { calls.leadsGet++; return r.fulfill(json({ leads: leadDb })); });
  await page.route('**/admin/experiences/leads/*', async (r) => {
    const id = r.request().url().split('/').pop();
    const body = r.request().postDataJSON();
    calls.leadPatch.push({ id, body });
    if (patchLead) return patchLead(r, body);
    const l = leadDb.find((x) => x.id === id);
    Object.assign(l, body);
    return r.fulfill(json({ lead: l }));
  });
  // D21: the confirmation email. Two segments after /leads/, so the single-star route above never sees it.
  await page.route('**/admin/experiences/leads/*/confirmation', async (r) => {
    const id = r.request().url().split('/').slice(-2)[0];
    const body = r.request().postDataJSON();
    calls.confirm.push({ id, body });
    if (confirmLead) return confirmLead(r, id);
    const l = leadDb.find((x) => x.id === id);
    l.confirmationSentAt = '2026-10-07T04:15:00.000Z';
    l.confirmationChannel = body && body.channel === 'whatsapp' ? 'whatsapp' : 'email';
    return r.fulfill(json({ lead: l }));
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
    photos: ['experiences/test-sunrise-hike/a'], partnerContact: null, tripadvisorLocationId: null, googlePlaceId: null, active: true,
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

  // A place link's `/@lat,lng` is where the MAP is centred; the place's own pin is `!3d<lat>!4d<lng>`.
  // Ops pastes place links, so the pin must win or the experience lands wherever the map was panned.
  await page.locator('#exp-loc').fill('https://www.google.com/maps/place/Atherya/@7.9,80.5,12z/data=!4m6!3m5!1s0x0:0x0!8m2!3d7.9571!4d80.7598');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toContainText('7.9571');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toContainText('80.7598');
});

// Live Tripadvisor ratings (spec D22): ops pastes the listing's web address (or just its number) and the
// form keeps only the digits - the one Tripadvisor datum we may store.
const TA_URL = 'https://www.tripadvisor.com/Attraction_Review-g304141-d6789012-Reviews-Atherya_Spa-Sigiriya_Central_Province.html?m=63959#photos';

test('Tripadvisor listing: a pasted address keeps only the digits after -d, with a check link', async ({ page }) => {
  const calls = await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page);
  await expect(page.locator('[data-testid="exp-ta-parsed"]')).toHaveCount(0);
  await page.locator('#exp-ta').fill(TA_URL);
  await expect(page.locator('[data-testid="exp-ta-parsed"]')).toContainText('6789012');
  await expect(page.locator('[data-testid="exp-ta-check"]')).toHaveText('Open listing');
  await expect(page.locator('[data-testid="exp-ta-check"]')).toHaveAttribute('target', '_blank');
  await expect(page.locator('[data-testid="exp-ta-check"]')).toHaveAttribute('rel', /noopener/);
  await expect(page.locator('[data-testid="exp-ta-check"]')).toHaveAttribute('href', /tripadvisor\.com.*d6789012/);
  await page.locator('[data-action="expSave"]').click();
  await expect(rows(page)).toHaveCount(4);
  expect(calls.post).toHaveLength(1);
  expect(calls.post[0].tripadvisorLocationId).toBe('6789012');
});

test('Tripadvisor listing: a bare id is accepted as is', async ({ page }) => {
  const calls = await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page);
  await page.locator('#exp-ta').fill('  6789012 ');
  await expect(page.locator('[data-testid="exp-ta-parsed"]')).toContainText('6789012');
  await page.locator('[data-action="expSave"]').click();
  await expect(rows(page)).toHaveCount(4);
  expect(calls.post[0].tripadvisorLocationId).toBe('6789012');
});

test('Tripadvisor listing: something unreadable shows an error under the field and sends nothing', async ({ page }) => {
  const calls = await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page);
  for (const bad of ['not a listing', 'https://www.tripadvisor.com/Tourism-g304141-Sigiriya.html', 'https://example.com/x-d6789012-Reviews-x', '12a', '1234567890123456']) {
    await page.locator('#exp-ta').fill(bad);
    await expect(page.locator('[data-testid="exp-ta-error"]'), bad).toContainText('Tripadvisor');
    await expect(page.locator('[data-testid="exp-ta-check"]')).toHaveCount(0);
    await page.locator('[data-action="expSave"]').click();
    await expect(page.locator('[data-testid="exp-ta-error"]')).toBeVisible();
    expect(calls.post, bad).toHaveLength(0);
  }
  await page.locator('#exp-ta').fill('6789012');
  await expect(page.locator('[data-testid="exp-ta-error"]')).toHaveCount(0);
});

test('Tripadvisor listing: editing shows the saved id; clearing the box sends null', async ({ page }) => {
  const calls = await boot(page, FOUNDER, { list: (r, db) => { db[0].tripadvisorLocationId = '6789012'; return r.fulfill(json({ experiences: db, stats: STATS })); } });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await rows(page).nth(0).locator('[data-action="expEdit"]').click();
  await expect(page.locator('#exp-ta')).toHaveValue('6789012');
  await expect(page.locator('[data-testid="exp-ta-parsed"]')).toContainText('6789012');
  await page.locator('#exp-ta').fill('');
  await expect(page.locator('[data-testid="exp-ta-error"]')).toHaveCount(0);
  await page.locator('[data-action="expSave"]').click();
  await expect.poll(() => calls.patch.length).toBe(1);
  expect(calls.patch[0].body.tripadvisorLocationId).toBeNull();
});

test('Tripadvisor listing: a server refusal is shown on the field', async ({ page }) => {
  await boot(page, FOUNDER, { post: (r) => r.fulfill(json({ error: 'bad_request', issues: [{ path: ['tripadvisorLocationId'], message: 'digits only, e.g. 6789012' }] }, 400)) });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await fillValid(page);
  await page.locator('#exp-ta').fill('6789012');
  await page.locator('[data-action="expSave"]').click();
  await expect(page.locator('#exp-form [data-err="ta"]')).toHaveText('digits only, e.g. 6789012');
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

// ── Leads tab (spec D13, D15) ────────────────────────────────────────────────
const lead = (over) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001', experienceId: EXPERIENCES[0].id, bookingId: 'b1', quoteId: null, source: 'booking_page',
  nameSnapshot: 'Ayurvedic massage', priceCentsSnapshot: 3500, priceUnitSnapshot: 'per_person', status: 'new', paymentRef: null,
  amountPaidCents: null, amountPaidCurrency: null, opsNote: null, updatedBy: null,
  createdAt: '2026-10-05T08:00:00.000Z', updatedAt: '2026-10-05T08:00:00.000Z',
  areaLabel: 'Sigiriya', experienceName: 'Ayurvedic massage', ownerKind: 'booking', reference: 'CH-0001',
  customerName: 'Maya Silva', contact: '+34 600 000 000', travelDate: futureIsoDate(30), ...over,
});
const LEADS = [
  lead({}),
  lead({ id: 'aaaaaaaa-0000-4000-8000-000000000002', experienceId: EXPERIENCES[2].id, bookingId: null, quoteId: 'q1', ownerKind: 'quote',
    nameSnapshot: 'Elephant jeep safari', experienceName: 'Elephant jeep safari', priceCentsSnapshot: 4500, priceUnitSnapshot: 'per_group',
    status: 'link_sent', paymentRef: 'PH-77', reference: 'Q-0007', customerName: 'Luca Rossi', contact: 'luca@example.com', travelDate: null }),
];
const leadRows = (page) => expPage(page).locator('[data-testid="lead-row"]');
async function openLeads(page, caps, opts) {
  const calls = await boot(page, caps, { leads: LEADS, ...opts });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await expPage(page).locator('[data-action="expTab"][data-tab="leads"]').click();
  return calls;
}

test('Leads tab lists each lead with who, what, when and the quoted price', async ({ page }) => {
  const calls = await openLeads(page, OPS);
  await expect(leadRows(page)).toHaveCount(2);
  expect(calls.leadsGet).toBe(1);
  const a = leadRows(page).nth(0);
  await expect(a).toContainText('Maya Silva');
  await expect(a).toContainText('+34 600 000 000');
  await expect(a).toContainText('CH-0001');
  await expect(a).toContainText('Sigiriya');
  await expect(a).toContainText('Ayurvedic massage');
  await expect(a).toContainText('$35 pp');
  await expect(a).toContainText(/travels \d{1,2} \w+ \d{4}/);
  await expect(a).toContainText('5 Oct 2026');
  await expect(a.locator('[data-action="expLeadStatus"]')).toHaveValue('new');
  await expect(a.locator('[data-lead-field="paymentRef"]')).toHaveCount(0); // payment inputs only for link sent / paid
  const b = leadRows(page).nth(1);
  await expect(b).toContainText('$45 per group');
  await expect(b).toContainText('Q-0007');
  await expect(b.locator('[data-action="expLeadStatus"]')).toHaveValue('link_sent');
  await expect(b.locator('[data-lead-field="paymentRef"]')).toHaveValue('PH-77');
  await expect(expPage(page).locator('[data-action="expTab"][data-tab="leads"]')).toHaveAttribute('aria-selected', 'true');
});

test('Leads tab: empty state, and values are escaped', async ({ page }) => {
  await boot(page, OPS, { leads: [] });
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await expPage(page).locator('[data-action="expTab"][data-tab="leads"]').click();
  await expect(expPage(page)).toContainText('No open leads yet.');

  const p2 = await page.context().newPage();
  await boot(p2, OPS, { leads: [lead({ customerName: '<img src=x onerror=window.__pwned=1>', opsNote: 'a "quoted" <b>note</b>' })] });
  await p2.goto(OPS_FILE + '#experiences');
  await ready(p2);
  await expPage(p2).locator('[data-action="expTab"][data-tab="leads"]').click();
  await expect(leadRows(p2).first()).toContainText('<img src=x onerror=window.__pwned=1>');
  await expect(leadRows(p2).first().locator('[data-lead-field="opsNote"]')).toHaveValue('a "quoted" <b>note</b>');
  expect(await p2.evaluate(() => window.__pwned)).toBeUndefined();
});

test('changing the status sends only {status}', async ({ page }) => {
  const calls = await openLeads(page, OPS);
  await leadRows(page).nth(0).locator('[data-action="expLeadStatus"]').selectOption('contacted');
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  expect(calls.leadPatch[0]).toEqual({ id: LEADS[0].id, body: { status: 'contacted' } });
  await expect(leadRows(page).nth(0).locator('[data-action="expLeadStatus"]')).toHaveValue('contacted');
});

test('paid without a PayHere reference says so and sends nothing', async ({ page }) => {
  const calls = await openLeads(page, OPS);
  const sel = leadRows(page).nth(0).locator('[data-action="expLeadStatus"]');
  await sel.selectOption('paid');
  await expect(page.locator('#toast')).toContainText('Add the PayHere reference first');
  await expect(sel).toHaveValue('new'); // put back: the row shows what the server holds
  // The payment inputs appear so the reference can be typed (still nothing sent).
  await expect(leadRows(page).nth(0).locator('[data-lead-field="paymentRef"]')).toBeVisible();
  expect(calls.leadPatch).toEqual([]);
});

test('paid with a reference sends {status, paymentRef} and the amount in cents', async ({ page }) => {
  const calls = await openLeads(page, OPS);
  const row = leadRows(page).nth(0);
  await row.locator('[data-action="expLeadStatus"]').selectOption('paid'); // shows the inputs, sends nothing
  expect(calls.leadPatch).toEqual([]);
  await row.locator('[data-lead-field="paymentRef"]').fill('PH-123');
  await row.locator('[data-lead-field="amount"]').fill('35.50');
  await row.locator('[data-lead-field="currency"]').selectOption('USD');
  await row.locator('[data-action="expLeadStatus"]').selectOption('paid');
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  expect(calls.leadPatch[0]).toEqual({ id: LEADS[0].id, body: { status: 'paid', paymentRef: 'PH-123', amountPaidCents: 3550, amountPaidCurrency: 'USD' } });
  await expect(row.locator('[data-action="expLeadStatus"]')).toHaveValue('paid');
});

test('paid on a lead that already holds a reference sends status only', async ({ page }) => {
  const calls = await openLeads(page, OPS);
  await leadRows(page).nth(1).locator('[data-action="expLeadStatus"]').selectOption('paid');
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  expect(calls.leadPatch[0]).toEqual({ id: LEADS[1].id, body: { status: 'paid' } });
});

test('the payment Save button sends only the changed payment fields; the note saves on blur', async ({ page }) => {
  const calls = await openLeads(page, OPS);
  const row = leadRows(page).nth(1);
  await row.locator('[data-lead-field="paymentRef"]').fill('PH-88');
  await row.locator('[data-action="expLeadSavePay"]').click();
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  expect(calls.leadPatch[0].body).toEqual({ paymentRef: 'PH-88' });

  const note = row.locator('[data-lead-field="opsNote"]');
  await note.fill('Sent on WhatsApp');
  await note.blur();
  await expect.poll(() => calls.leadPatch.length).toBe(2);
  expect(calls.leadPatch[1].body).toEqual({ opsNote: 'Sent on WhatsApp' });
  await note.focus();
  await note.blur(); // unchanged: nothing more is sent
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  expect(calls.leadPatch).toHaveLength(2);
});

// A note written while another save on the same lead is still in flight used to be dropped
// silently (the busy guard returned early). Hold the first PATCH open to make that window certain.
test('a note blurred while a payment save is still in flight is saved after it, not dropped', async ({ page }) => {
  let n = 0;
  let release;
  const held = new Promise((res) => { release = res; });
  const calls = await openLeads(page, OPS, {
    patchLead: async (r, body) => {
      n++;
      if (n === 1) await held;
      return r.fulfill(json({ lead: { ...LEADS[1], ...body } }));
    },
  });
  const row = leadRows(page).nth(1);
  await row.locator('[data-lead-field="paymentRef"]').fill('PH-88');
  await row.locator('[data-action="expLeadSavePay"]').click();
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  const note = row.locator('[data-lead-field="opsNote"]');
  await note.fill('Sent on WhatsApp');
  await note.blur(); // the payment PATCH has not answered yet
  release();
  await expect.poll(() => calls.leadPatch.length).toBe(2);
  expect(calls.leadPatch[1].body).toEqual({ opsNote: 'Sent on WhatsApp' });
});

test('a failed save puts the status back and says so', async ({ page }) => {
  const calls = await openLeads(page, OPS, { patchLead: (r) => r.fulfill(json({ error: 'boom' }, 500)) });
  const sel = leadRows(page).nth(0).locator('[data-action="expLeadStatus"]');
  await sel.selectOption('contacted');
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await expect(page.locator('#toast')).toContainText('Couldn’t save');
  await expect(sel).toHaveValue('new');
});

test('the reference opens the booking sheet; a quote reference opens the quote', async ({ page }) => {
  await openLeads(page, OPS);
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([{
    id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Maya Silva', customerFirstName: 'Maya', mode: 'single',
    route: 'Colombo → Sigiriya', travelDate: futureIsoDate(30), travelTime: '09:00', pax: 2, amount: 3900, currency: 'USD', stage: 'paid',
    paymentStatus: 'succeeded', vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null,
  }])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json({
    payLink: null, experienceInterests: [],
    booking: { id: 'b1', reference: 'CH-0001', currency: 'USD', status: 'paid', mode: 'single', createdAt: '2026-09-01T00:00:00Z',
      input: { customer: { whatsapp: '+34 600', email: 'm@example.com', country: 'Spain' } } },
    ops: {}, payments: [{ id: 'p1', status: 'succeeded', amount: 3900, currency: 'USD' }], refunds: [],
  })));
  await leadRows(page).nth(0).locator('[data-action="expLeadOpen"]').click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
  await expect(page.locator('.sheet-b')).toContainText('m@example.com');
  expect(new URL(page.url()).searchParams.get('booking')).toBe('b1');
});

// ── Confirmation email (spec D21) ────────────────────────────────────────────
const PAID = lead({ status: 'paid', paymentRef: 'PH-1', amountPaidCents: 3500, amountPaidCurrency: 'USD' });
const PAID_QUOTE = lead({
  id: 'aaaaaaaa-0000-4000-8000-000000000003', bookingId: null, quoteId: 'q9', ownerKind: 'quote', reference: 'Q-0009', customerName: 'Luca Rossi',
  contact: '+39 333 000 0000', status: 'paid', paymentRef: 'PH-2',
});
async function openPaid(page, leads, opts) {
  const calls = await openLeads(page, OPS, { leads, ...opts });
  await expect(leadRows(page)).toHaveCount(leads.length);
  return calls;
}

test('a paid lead shows the schedule inputs and Send confirmation; an open lead does not', async ({ page }) => {
  await openPaid(page, [PAID, lead({ id: 'aaaaaaaa-0000-4000-8000-000000000009', status: 'contacted' })]);
  const paid = leadRows(page).nth(0);
  await expect(paid.locator('[data-lead-field="scheduledDate"]')).toHaveAttribute('type', 'date');
  await expect(paid.locator('[data-lead-field="scheduledTime"]')).toHaveAttribute('type', 'time');
  await expect(paid.locator('[data-lead-field="meetingPoint"]')).toBeVisible();
  await expect(paid.locator('[data-action="expLeadConfirm"]')).toHaveText('Send confirmation');
  await expect(leadRows(page).nth(1).locator('[data-lead-field="scheduledDate"]')).toHaveCount(0);
  await expect(leadRows(page).nth(1).locator('[data-action="expLeadConfirm"]')).toHaveCount(0);
});

test('Send confirmation without a date and time says so and sends nothing', async ({ page }) => {
  const calls = await openPaid(page, [PAID]);
  await leadRows(page).nth(0).locator('[data-action="expLeadConfirm"]').click();
  await expect(page.locator('#toast')).toContainText('Add the date and time first');
  expect(calls.confirm).toEqual([]);
  expect(calls.leadPatch).toEqual([]);
  // a date alone is not enough either
  await leadRows(page).nth(0).locator('[data-lead-field="scheduledDate"]').fill(futureIsoDate(20));
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await leadRows(page).nth(0).locator('[data-action="expLeadConfirm"]').click();
  expect(calls.confirm).toEqual([]);
});

test('with a date and time, Send confirmation saves the schedule, sends, then shows Sent and Resend', async ({ page }) => {
  const day = futureIsoDate(20);
  const calls = await openPaid(page, [PAID]);
  const row = leadRows(page).nth(0);
  await row.locator('[data-lead-field="scheduledDate"]').fill(day);
  await row.locator('[data-lead-field="scheduledTime"]').fill('09:30');
  await row.locator('[data-lead-field="meetingPoint"]').fill('Hotel lobby');
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect.poll(() => calls.confirm.length).toBe(1);
  expect(calls.confirm[0].id).toBe(PAID.id);
  // every field reached the server before the email went
  const saved = Object.assign({}, ...calls.leadPatch.map((c) => c.body));
  expect(saved).toEqual({ scheduledDate: day, scheduledTime: '09:30', meetingPoint: 'Hotel lobby' });
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmation sent ✓');
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Oct');
  await expect(row.locator('[data-action="expLeadConfirm"]')).toHaveText('Resend');
  await expect(row.locator('[data-lead-field="scheduledTime"]')).toHaveValue('09:30');
  // Resend is the same call
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect.poll(() => calls.confirm.length).toBe(2);
});

test('a quote lead with no email on file says to confirm on WhatsApp, and stays unsent', async ({ page }) => {
  const calls = await openPaid(page, [{ ...PAID_QUOTE, scheduledDate: futureIsoDate(20), scheduledTime: '10:00' }], {
    confirmLead: (r) => r.fulfill(json({ error: 'no_email' }, 422)),
  });
  const row = leadRows(page).nth(0);
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect.poll(() => calls.confirm.length).toBe(1);
  await expect(page.locator('#toast')).toContainText('No email on file — confirm on WhatsApp');
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toHaveCount(0);
  await expect(row.locator('[data-action="expLeadConfirm"]')).toHaveText('Send confirmation');
});

// A phone-only quote lead can never be emailed, so ops marks it confirmed on WhatsApp (nothing is sent).
test('a quote lead with a phone contact offers Mark confirmed on WhatsApp; it posts the channel and shows the stamp', async ({ page }) => {
  const calls = await openPaid(page, [PAID_QUOTE, PAID]);
  const row = leadRows(page).nth(0);
  await expect(row.locator('[data-testid="lead-confirm-whatsapp"]')).toHaveText('Mark confirmed on WhatsApp');
  // an emailable booking lead does not offer it until the email path says there is no email
  await expect(leadRows(page).nth(1).locator('[data-testid="lead-confirm-whatsapp"]')).toHaveCount(0);
  await row.locator('[data-testid="lead-confirm-whatsapp"]').click();
  await expect.poll(() => calls.confirm.length).toBe(1);
  expect(calls.confirm[0]).toEqual({ id: PAID_QUOTE.id, body: { channel: 'whatsapp' } });
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmed on WhatsApp ✓');
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Oct');
  await expect(row.locator('[data-testid="lead-confirm-whatsapp"]')).toHaveCount(0);
  await expect(row.locator('[data-action="expLeadConfirm"]')).toHaveText('Send confirmation');
});

test('a booking lead whose email send answers no_email then offers Mark confirmed on WhatsApp', async ({ page }) => {
  let n = 0;
  const calls = await openPaid(page, [{ ...PAID, scheduledDate: futureIsoDate(20), scheduledTime: '10:00' }], {
    confirmLead: (r, id) => {
      n++;
      return n === 1 ? r.fulfill(json({ error: 'no_email' }, 422)) : r.fulfill(json({ lead: { ...PAID, confirmationSentAt: '2026-10-07T04:15:00.000Z', confirmationChannel: 'whatsapp' } }));
    },
  });
  const row = leadRows(page).nth(0);
  await expect(row.locator('[data-testid="lead-confirm-whatsapp"]')).toHaveCount(0);
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect(page.locator('#toast')).toContainText('No email on file — confirm on WhatsApp');
  await row.locator('[data-testid="lead-confirm-whatsapp"]').click();
  await expect.poll(() => calls.confirm.length).toBe(2);
  expect(calls.confirm[1].body).toEqual({ channel: 'whatsapp' });
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmed on WhatsApp ✓');
});

// A double click used to reach the POST twice: the claim was only taken after two awaits.
test('a quick double click on Send confirmation produces exactly one POST', async ({ page }) => {
  let release;
  const held = new Promise((res) => { release = res; });
  const calls = await openPaid(page, [{ ...PAID, scheduledDate: futureIsoDate(20), scheduledTime: '10:00' }], {
    confirmLead: async (r) => { await held; return r.fulfill(json({ lead: { ...PAID, confirmationSentAt: '2026-10-07T04:15:00.000Z', confirmationChannel: 'email' } })); },
  });
  const btn = leadRows(page).nth(0).locator('[data-action="expLeadConfirm"]');
  await btn.dblclick();
  await expect.poll(() => calls.confirm.length).toBe(1);
  await expect(btn).toBeDisabled();
  await btn.click({ force: true }); // a third press while it is still out
  await page.waitForTimeout(150);
  expect(calls.confirm).toHaveLength(1);
  release();
  await expect(leadRows(page).nth(0).locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmation sent ✓');
  await expect(leadRows(page).nth(0).locator('[data-action="expLeadConfirm"]')).toBeEnabled();
  expect(calls.confirm).toHaveLength(1);
});

test('a failed send says so and can be tried again', async ({ page }) => {
  const calls = await openPaid(page, [{ ...PAID, scheduledDate: futureIsoDate(20), scheduledTime: '10:00' }], {
    confirmLead: (r) => r.fulfill(json({ error: 'send_failed' }, 502)),
  });
  const row = leadRows(page).nth(0);
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect(page.locator('#toast')).toContainText('Couldn’t send — try again.');
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toHaveCount(0);
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect.poll(() => calls.confirm.length).toBe(2);
});

// Staging 2026-10-13: the email allowlist stopped the message and the page said "try again". A
// suppressed send is not a failure to retry — say what happened and offer the WhatsApp path instead.
test('a send the environment suppressed says so and offers Mark confirmed on WhatsApp', async ({ page }) => {
  let n = 0;
  const calls = await openPaid(page, [{ ...PAID, scheduledDate: futureIsoDate(20), scheduledTime: '10:00' }], {
    confirmLead: (r) => {
      n++;
      return n === 1
        ? r.fulfill(json({ error: 'email_suppressed', reason: 'suppressed_allowlist' }, 422))
        : r.fulfill(json({ lead: { ...PAID, confirmationSentAt: '2026-10-07T04:15:00.000Z', confirmationChannel: 'whatsapp' } }));
    },
  });
  const row = leadRows(page).nth(0);
  await expect(row.locator('[data-testid="lead-confirm-whatsapp"]')).toHaveCount(0);
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect(page.locator('#toast')).toContainText('Email to this address is switched off on this environment — confirm on WhatsApp instead');
  await expect(page.locator('#toast')).not.toContainText('try again');
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toHaveCount(0);
  await row.locator('[data-testid="lead-confirm-whatsapp"]').click();
  await expect.poll(() => calls.confirm.length).toBe(2);
  expect(calls.confirm[1].body).toEqual({ channel: 'whatsapp' });
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmed on WhatsApp ✓');
});

// The same in-flight idiom as the note: a schedule typed while the date save is still on the wire is
// saved after it, not dropped.
test('a meeting point typed while the date save is in flight is saved after it, not dropped', async ({ page }) => {
  let n = 0;
  let release;
  const held = new Promise((res) => { release = res; });
  const calls = await openPaid(page, [PAID], {
    patchLead: async (r, body) => {
      n++;
      if (n === 1) await held;
      return r.fulfill(json({ lead: { ...PAID, ...body } }));
    },
  });
  const row = leadRows(page).nth(0);
  await row.locator('[data-lead-field="scheduledDate"]').fill(futureIsoDate(20));
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  const meet = row.locator('[data-lead-field="meetingPoint"]');
  await meet.fill('Hotel lobby');
  await meet.blur(); // the date PATCH has not answered yet
  release();
  await expect.poll(() => calls.leadPatch.length).toBe(2);
  expect(calls.leadPatch[1].body).toEqual({ meetingPoint: 'Hotel lobby' });
});

// Staging 2026-10-13: date, time and meeting point changed back to back, then Send confirmation. The
// later saves queue behind the first; the press queued with them, woke with them, found the lead busy
// with a queued save and gave up: no POST, no toast, and the button left disabled until the next repaint.
test('Send confirmation pressed while schedule saves are queued waits for them, then sends once', async ({ page }) => {
  const day = futureIsoDate(20);
  const server = { ...PAID };
  let atSend = null;
  let release;
  const held = new Promise((res) => { release = res; });
  let n = 0;
  const calls = await openPaid(page, [PAID], {
    patchLead: async (r, body) => {
      n++;
      if (n === 1) await held; // the date save stays on the wire while the rest queue behind it
      Object.assign(server, body);
      return r.fulfill(json({ lead: { ...server } }));
    },
    confirmLead: (r) => {
      atSend = { ...server };
      return r.fulfill(json({ lead: { ...server, confirmationSentAt: '2026-10-07T04:15:00.000Z', confirmationChannel: 'email' } }));
    },
  });
  const row = leadRows(page).nth(0);
  const btn = row.locator('[data-action="expLeadConfirm"]');
  await row.locator('[data-lead-field="scheduledDate"]').fill(day);
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await row.locator('[data-lead-field="scheduledTime"]').fill('09:30');
  await row.locator('[data-lead-field="meetingPoint"]').fill('Hotel lobby');
  await btn.click(); // blurs the meeting point (its save queues too), then presses Send
  await expect(btn).toBeDisabled();
  expect(calls.confirm).toEqual([]); // nothing is sent ahead of the saves
  release();
  await expect.poll(() => calls.confirm.length).toBe(1);
  // the email went only once the server held everything on screen
  expect(atSend).toMatchObject({ scheduledDate: day, scheduledTime: '09:30', meetingPoint: 'Hotel lobby' });
  await expect(page.locator('#toast')).toContainText('Confirmation sent');
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmation sent ✓');
  await expect(row.locator('[data-action="expLeadConfirm"]')).toBeEnabled();
  await expect(row.locator('[data-action="expLeadConfirm"]')).toHaveText('Resend');
  expect(calls.confirm).toHaveLength(1);
});

// The WhatsApp button shares the claim, so it shared the stuck button.
test('Mark confirmed on WhatsApp pressed while schedule saves are queued waits for them, then records once', async ({ page }) => {
  let release;
  const held = new Promise((res) => { release = res; });
  let n = 0;
  const calls = await openPaid(page, [PAID_QUOTE], {
    patchLead: async (r, body) => {
      n++;
      if (n === 1) await held;
      return r.fulfill(json({ lead: { ...PAID_QUOTE, ...body } }));
    },
  });
  const row = leadRows(page).nth(0);
  const btn = row.locator('[data-testid="lead-confirm-whatsapp"]');
  await row.locator('[data-lead-field="scheduledDate"]').fill(futureIsoDate(20));
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await row.locator('[data-lead-field="scheduledTime"]').fill('09:30'); // queues behind the date save
  await btn.click();
  await expect(btn).toBeDisabled();
  expect(calls.confirm).toEqual([]);
  release();
  await expect.poll(() => calls.confirm.length).toBe(1);
  expect(calls.confirm[0]).toEqual({ id: PAID_QUOTE.id, body: { channel: 'whatsapp' } });
  expect(calls.leadPatch.map((c) => c.body)).toContainEqual({ scheduledTime: '09:30' });
  await expect(page.locator('#toast')).toContainText('Marked confirmed on WhatsApp');
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmed on WhatsApp ✓');
  await expect(row.locator('[data-action="expLeadConfirm"]')).toBeEnabled();
  expect(calls.confirm).toHaveLength(1);
});

// Two schedule fields changed while the date save was out woke together and PATCHed at once; the
// slower answer, the server's row from before the other write, then overwrote the page's copy of the
// lead — which is what the next repaint shows.
test('schedule saves queued behind one in-flight save go out one at a time, and the row keeps every value', async ({ page }) => {
  const day = futureIsoDate(20);
  const server = { ...PAID, scheduledDate: null, scheduledTime: null, meetingPoint: null }; // the API's row carries every column
  const gates = []; // the first two PATCH answers wait for the test
  let n = 0;
  const calls = await openPaid(page, [PAID], {
    patchLead: async (r, body) => {
      const i = n++;
      Object.assign(server, body);
      const row = { ...server }; // the server answers with its row as of this write
      if (i < 2) await new Promise((res) => { gates[i] = res; });
      return r.fulfill(json({ lead: row }));
    },
    confirmLead: (r) => r.fulfill(json({ lead: { ...server, confirmationSentAt: '2026-10-07T04:15:00.000Z', confirmationChannel: 'email' } })),
  });
  const row = leadRows(page).nth(0);
  await row.locator('[data-lead-field="scheduledDate"]').fill(day);
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await row.locator('[data-lead-field="scheduledTime"]').fill('09:30'); // queues behind the date save
  const meet = row.locator('[data-lead-field="meetingPoint"]');
  await meet.fill('Hotel lobby');
  await meet.blur(); // queues too
  gates[0]();
  await expect.poll(() => calls.leadPatch.length).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(150);
  expect(calls.leadPatch).toHaveLength(2); // the meeting point waits for the time save, not alongside it
  expect(calls.leadPatch[1].body).toEqual({ scheduledTime: '09:30' });
  const timeAnswered = page.waitForResponse((res) => res.request().method() === 'PATCH' && (res.request().postData() || '').includes('scheduledTime'));
  gates[1]();
  await expect.poll(() => calls.leadPatch.length).toBe(3);
  await timeAnswered;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  const last = {};
  calls.leadPatch.forEach((c) => Object.keys(c.body).forEach((k) => { last[k] = c.body[k]; }));
  expect(last).toEqual({ scheduledDate: day, scheduledTime: '09:30', meetingPoint: 'Hotel lobby' });
  expect(server).toMatchObject(last);
  // So does the page's copy of the lead. Send confirmation saves whatever that copy lacks before the email;
  // a copy the slower answer did not take the meeting point back out of has nothing to save: one POST, no
  // further PATCH.
  await row.locator('[data-action="expLeadConfirm"]').click();
  await expect.poll(() => calls.confirm.length).toBe(1);
  expect(calls.leadPatch).toHaveLength(3);
  await expect(row.locator('[data-testid="lead-confirmation-sent"]')).toContainText('Confirmation sent ✓');
  await expect(row.locator('[data-lead-field="meetingPoint"]')).toHaveValue('Hotel lobby');
  await expect(row.locator('[data-lead-field="scheduledTime"]')).toHaveValue('09:30');
  await expect(row.locator('[data-lead-field="scheduledDate"]')).toHaveValue(day);
});

// A status picked while a save was out was put straight back by the busy guard: the pick was lost
// without a word.
test('a status picked while a save is in flight is applied after it, not put back', async ({ page }) => {
  const server = { ...LEADS[1] };
  let release;
  const held = new Promise((res) => { release = res; });
  let n = 0;
  const calls = await openLeads(page, OPS, {
    patchLead: async (r, body) => {
      n++;
      if (n === 1) await held;
      Object.assign(server, body);
      return r.fulfill(json({ lead: { ...server } }));
    },
  });
  const row = leadRows(page).nth(1);
  const note = row.locator('[data-lead-field="opsNote"]');
  await note.fill('Sent on WhatsApp');
  await note.blur();
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  const sel = row.locator('[data-action="expLeadStatus"]');
  await sel.selectOption('contacted'); // the note PATCH has not answered yet
  release();
  await expect.poll(() => calls.leadPatch.length).toBe(2);
  expect(calls.leadPatch[1].body).toEqual({ status: 'contacted' });
  await expect(sel).toHaveValue('contacted');
});

// Save payment had the same guard: pressed during a save, it did nothing.
test('Save payment pressed while a save is in flight is applied after it, not dropped', async ({ page }) => {
  const server = { ...LEADS[1] };
  let release;
  const held = new Promise((res) => { release = res; });
  let n = 0;
  const calls = await openLeads(page, OPS, {
    patchLead: async (r, body) => {
      n++;
      if (n === 1) await held;
      Object.assign(server, body);
      return r.fulfill(json({ lead: { ...server } }));
    },
  });
  const row = leadRows(page).nth(1);
  const note = row.locator('[data-lead-field="opsNote"]');
  await note.fill('Sent on WhatsApp');
  await note.blur();
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await row.locator('[data-lead-field="paymentRef"]').fill('PH-88');
  await row.locator('[data-action="expLeadSavePay"]').click(); // the note PATCH has not answered yet
  release();
  await expect.poll(() => calls.leadPatch.length).toBe(2);
  expect(calls.leadPatch[1].body).toEqual({ paymentRef: 'PH-88' });
  await expect(page.locator('#toast')).toContainText('Saved');
  await expect(row.locator('[data-lead-field="paymentRef"]')).toHaveValue('PH-88');
});

// ── Catalogue counts follow the Leads tab ────────────────────────────────────
// "N interested · N paid" on a Catalogue row is read once on arrival. Setting a lead to Paid and
// coming back to the Catalogue still showed the old count until the page was left and re-entered.
// The stub's stats move with the lead write, as the server's would.
const jeep = EXPERIENCES[2];
const statsFor = (n) => [{ experienceId: jeep.id, interested: 1, paid: n, paidCents: { USD: 4500 * n, LKR: 0 } }];

test('switching back to the Catalogue shows counts changed in the Leads tab', async ({ page }) => {
  let paid = 0;
  const calls = await openLeads(page, OPS, {
    list: (r, db) => r.fulfill(json({ experiences: db, stats: statsFor(paid) })),
    patchLead: (r, body) => { if (body.status === 'paid') paid = 1; return r.fulfill(json({ lead: { ...LEADS[1], ...body } })); },
  });
  await leadRows(page).nth(1).locator('[data-action="expLeadStatus"]').selectOption('paid');
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await expPage(page).locator('[data-action="expTab"][data-tab="catalogue"]').click();
  await expect(rows(page).nth(2)).toContainText('1 paid');
  await expect(rows(page).nth(2)).not.toContainText('0 paid');
});

test('a slow Catalogue reload that lands after a newer one cannot put the old counts back', async ({ page }) => {
  let paid = 0, getN = 0, releaseSlow;
  const slow = new Promise((res) => { releaseSlow = res; });
  const calls = await openLeads(page, OPS, {
    list: async (r, db) => {
      const n = ++getN, snapshot = paid; // the counts as they stood when this request arrived
      if (n === 2) await slow;           // the first Catalogue revisit answers late
      return r.fulfill(json({ experiences: db, stats: statsFor(snapshot) }));
    },
    patchLead: (r, body) => { if (body.status === 'paid') paid = 1; return r.fulfill(json({ lead: { ...LEADS[1], ...body } })); },
  });
  const catalogue = expPage(page).locator('[data-action="expTab"][data-tab="catalogue"]');
  await catalogue.click();                                                            // GET #2: held, still the old counts
  await expPage(page).locator('[data-action="expTab"][data-tab="leads"]').click();
  await leadRows(page).nth(1).locator('[data-action="expLeadStatus"]').selectOption('paid');
  await expect.poll(() => calls.leadPatch.length).toBe(1);
  await catalogue.click();                                                            // GET #3: fresh counts
  await expect(rows(page).nth(2)).toContainText('1 paid');
  releaseSlow();
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  await expect(rows(page).nth(2)).toContainText('1 paid');
});

// Photo tiles (2026-10-18). With uploads on, photos are thumbnails with Add / Replace / Remove, and the
// raw path boxes sit behind "Use a photo already on the site" (spec 2026-10-17 P6, revised).
const UPLOADED = 'https://img-staging.ceylonhop.com/experiences/5f0c2a3e-7b1d-4c2e-9a6f-0d1e2f3a4b5c';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const withUploads = { list: (r, db) => r.fulfill(json({ experiences: db, stats: STATS, uploads: true })) };
const tiles = (page) => page.locator('[data-testid^="exp-photo-tile-"]');

async function stubUpload(page, reply) {
  const posts = [];
  // Registered after boot's '**/admin/experiences/*' route: Playwright prefers the last match.
  await page.route('**/admin/experiences/photos', (r) => { posts.push(r.request().postDataBuffer()); return reply(r); });
  await page.route('https://img-staging.ceylonhop.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));
  return posts;
}

async function choosePhoto(page, testid) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-testid="' + testid + '"]').click();
  await (await chooser).setFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
}

async function openEdit(page, i) {
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await rows(page).nth(i).locator('[data-action="expEdit"]').click();
}

test('tiles: an experience\'s photos show as thumbnails, with no path boxes or URLs', async ({ page }) => {
  await boot(page, OPS, withUploads);
  await openEdit(page, 1); // Village cooking lesson: two Sigiriya guide photos
  await expect(tiles(page)).toHaveCount(2);
  await expect(tiles(page).nth(0).locator('img')).toHaveAttribute('src', 'https://ceylonhop.com/img/guides/sigiriya/family-food-900.jpg');
  await expect(tiles(page).nth(1).locator('img')).toHaveAttribute('src', 'https://ceylonhop.com/img/guides/sigiriya/village-900.jpg');
  await expect(page.locator('[data-testid="exp-photo-add"]')).toBeVisible();
  await expect(page.locator('#exp-photo-0')).toBeHidden();
  await expect(page.locator('#exp-form')).not.toContainText('slug/photo');
});

test('tiles: Add uploads two JPEGs and Save sends the new photo after the existing ones', async ({ page }) => {
  const calls = await boot(page, OPS, withUploads);
  const posts = await stubUpload(page, (r) => r.fulfill(json({ stem: UPLOADED }, 201)));
  await openEdit(page, 1);
  await choosePhoto(page, 'exp-photo-add');
  await expect(tiles(page)).toHaveCount(3);
  await expect(tiles(page).nth(2).locator('img')).toHaveAttribute('src', UPLOADED + '-900.jpg');
  await expect(tiles(page).nth(2).locator('[data-testid="exp-photo-note"]')).toHaveCount(0);
  expect(posts).toHaveLength(1);
  const body = posts[0].toString('latin1');
  expect(body).toContain('name="large"');
  expect(body).toContain('name="small"');
  expect(body.split('\xff\xd8\xff').length - 1).toBe(2); // two JPEGs, even from a PNG
  await page.locator('[data-action="expSave"]').click();
  await expect.poll(() => calls.patch.length).toBe(1);
  expect(calls.patch[0].body.photos).toEqual(['guides/sigiriya/family-food', 'guides/sigiriya/village', UPLOADED]);
});

test('tiles: Replace swaps a photo in place and Remove takes one out', async ({ page }) => {
  const calls = await boot(page, OPS, withUploads);
  await stubUpload(page, (r) => r.fulfill(json({ stem: UPLOADED }, 201)));
  await openEdit(page, 1);
  await choosePhoto(page, 'exp-photo-replace-0');
  await expect(tiles(page).nth(0).locator('img')).toHaveAttribute('src', UPLOADED + '-900.jpg');
  await page.locator('[data-testid="exp-photo-remove-1"]').click();
  await expect(tiles(page)).toHaveCount(1);
  await page.locator('[data-action="expSave"]').click();
  await expect.poll(() => calls.patch.length).toBe(1);
  expect(calls.patch[0].body.photos).toEqual([UPLOADED]);
});

test('tiles: "Use a photo already on the site" opens the path boxes; a typed path comes back as a tile', async ({ page }) => {
  await boot(page, OPS, withUploads);
  await openEdit(page, 0); // Ayurvedic massage: one photo
  const link = page.locator('[data-testid="exp-photo-paths"]');
  await expect(link).toHaveText('Use a photo already on the site');
  await link.click();
  await expect(page.locator('#exp-photo-1')).toBeVisible();
  await expect(tiles(page).first()).toBeHidden();
  await page.locator('#exp-photo-1').fill('guides/sigiriya/live-lion-rock');
  await expect(link).toHaveText('Back to photo tiles');
  await link.click();
  await expect(page.locator('#exp-photo-1')).toBeHidden();
  await expect(tiles(page)).toHaveCount(2);
  await expect(tiles(page).nth(1).locator('img')).toHaveAttribute('src', 'https://ceylonhop.com/img/guides/sigiriya/live-lion-rock-900.jpg');
});

test('tiles: a failed upload says so and adds nothing', async ({ page }) => {
  await boot(page, OPS, withUploads);
  await stubUpload(page, (r) => r.fulfill(json({ error: 'upload_failed' }, 502)));
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await choosePhoto(page, 'exp-photo-add');
  await expect(page.locator('[data-err="photos"]')).toHaveText('Upload failed — try again.');
  await expect(tiles(page)).toHaveCount(0);
  await expect(page.locator('[data-testid="exp-photo-add"]')).toHaveText('+ Add photo');
});

test('tiles: with uploads off the form keeps the plain path boxes', async ({ page }) => {
  await boot(page, OPS);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
  await expect(page.locator('#exp-photo-0')).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
  await expect(page.locator('[data-testid="exp-photo-add"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="exp-photo-paths"]')).toHaveCount(0);
});

// "Find the business on Google" (2026-10-18). Search on = the catalogue GET says businessSearch: true.
const BIZ = {
  placeId: 'ChIJAtherya0000000000000', name: 'Atherya Ayurveda Spa', address: 'Kibissa, Sigiriya 21120, Sri Lanka',
  lat: 7.9571, lng: 80.7601, area: 'Sigiriya', phone: '+94 77 123 4567', website: 'https://atherya.lk/', mapsUrl: 'https://maps.google.com/?cid=1',
  openWeekdays: [1, 2, 3, 4, 5, 6],
};
const withBusiness = { list: (r, db) => r.fulfill(json({ experiences: db, stats: STATS, businessSearch: true })) };

// Registered after boot's '**/admin/experiences/*' route: Playwright prefers the last match.
async function stubBusiness(page, { search, details } = {}) {
  const calls = { search: [], details: [] };
  await page.route('**/admin/experiences/business-search**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q');
    calls.search.push(q);
    if (search) return search(r, q);
    const { placeId, name, address, lat, lng } = BIZ;
    return r.fulfill(json({ candidates: [{ placeId, name, address, lat, lng }] }));
  });
  await page.route('**/admin/experiences/business/*', (r) => {
    const id = r.request().url().split('/').pop();
    calls.details.push(id);
    if (details) return details(r, id);
    return r.fulfill(json({ business: BIZ }));
  });
  return calls;
}

async function openNew(page) {
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await page.locator('[data-testid="exp-new"]').click();
}

test('business: picking a Google result fills partner, area, pin and contact, and Save keeps the place id', async ({ page }) => {
  const calls = await boot(page, OPS, withBusiness);
  const biz = await stubBusiness(page);
  await openNew(page);
  await expect(page.locator('#exp-loc')).toBeHidden(); // the pin comes from Google; the box is behind a link
  await page.locator('#exp-biz-q').fill('atherya sigiriya');
  await page.locator('#exp-biz-q').press('Enter');
  const pick = page.locator('[data-testid="exp-biz-result"]');
  await expect(pick).toHaveCount(1);
  await expect(pick).toContainText('Atherya Ayurveda Spa');
  await expect(pick).toContainText('Kibissa, Sigiriya 21120, Sri Lanka');
  await pick.click();
  await expect(page.locator('#exp-partner')).toHaveValue('Atherya Ayurveda Spa');
  await expect(page.locator('#exp-area')).toHaveValue('Sigiriya');
  await expect(page.locator('#exp-contact')).toHaveValue('+94 77 123 4567 · https://atherya.lk/');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toHaveText('Lat 7.9571 · Lng 80.7601');
  await expect(page.locator('[data-testid="exp-biz-picked"]')).toContainText('Atherya Ayurveda Spa');
  expect(biz.search).toEqual(['atherya sigiriya']);
  expect(biz.details).toEqual([BIZ.placeId]);

  await page.locator('#exp-slug').fill('ayurvedic-massage');
  await page.locator('#exp-name').fill('Ayurvedic massage');
  await page.locator('#exp-summary').fill('A 90-minute massage.');
  await page.locator('#exp-price').fill('35');
  await page.locator('#exp-biz-confirm').check();
  await page.locator('[data-action="expSave"]').click();
  await expect.poll(() => calls.post.length).toBe(1);
  expect(calls.post[0]).toMatchObject({
    partnerName: 'Atherya Ayurveda Spa', areaLabel: 'Sigiriya', lat: 7.9571, lng: 80.7601,
    partnerContact: '+94 77 123 4567 · https://atherya.lk/', googlePlaceId: BIZ.placeId,
  });
});

test('business: "Enter the location by hand" shows the lat/lng box', async ({ page }) => {
  await boot(page, OPS, withBusiness);
  await stubBusiness(page);
  await openNew(page);
  await page.locator('[data-action="expLocManual"]').click();
  await expect(page.locator('#exp-loc')).toBeVisible();
  await expect(page.locator('[data-action="expLocManual"]')).toBeHidden();
  await page.locator('#exp-loc').fill('7.977, 80.76');
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toHaveText('Lat 7.977 · Lng 80.76');
});

test('business: no match, and Google unavailable, each say so and leave the form alone', async ({ page }) => {
  await boot(page, OPS, withBusiness);
  let off = false;
  await stubBusiness(page, { search: (r) => (off ? r.fulfill(json({ error: 'business_off' }, 503)) : r.fulfill(json({ candidates: [] }))) });
  await openNew(page);
  await page.locator('#exp-biz-q').fill('nothing here');
  await page.locator('[data-action="expBizSearch"]').click();
  await expect(page.locator('[data-testid="exp-biz-msg"]')).toHaveText('No match on Google — try the business name and town, or enter the details by hand.');
  off = true;
  await page.locator('[data-action="expBizSearch"]').click();
  await expect(page.locator('[data-testid="exp-biz-msg"]')).toHaveText('Google search isn’t available right now — enter the details by hand.');
  await expect(page.locator('#exp-partner')).toHaveValue('');
});

test('business: editing an experience shows its pin, not an empty box', async ({ page }) => {
  await boot(page, OPS, withBusiness);
  await stubBusiness(page);
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await rows(page).nth(0).locator('[data-action="expEdit"]').click();
  await expect(page.locator('#exp-loc')).toBeHidden();
  await expect(page.locator('[data-testid="exp-loc-parsed"]')).toHaveText('Lat 7.977 · Lng 80.76');
});

test('business: with no Google key the form has no search and keeps the lat/lng box', async ({ page }) => {
  await boot(page, OPS);
  await openNew(page);
  await expect(page.locator('#exp-biz-q')).toHaveCount(0);
  await expect(page.locator('#exp-loc')).toBeVisible();
});

// Fuller fill (2026-10-18): slug + name suggested from the business, open days from Google's hours, ops
// confirms Google's partner details before saving, and Google's photos are a link, never copied.
async function pickBusiness(page) {
  await page.locator('#exp-biz-q').fill('atherya');
  await page.locator('#exp-biz-q').press('Enter');
  await page.locator('[data-testid="exp-biz-result"]').click();
  await expect(page.locator('#exp-partner')).toHaveValue(BIZ.name);
}

test('fill: slug, name and open days come from the pick; days follow Google’s hours', async ({ page }) => {
  await boot(page, OPS, withBusiness);
  await stubBusiness(page);
  await openNew(page);
  await pickBusiness(page);
  await expect(page.locator('#exp-slug')).toHaveValue('atherya-ayurveda-spa');
  await expect(page.locator('#exp-name')).toHaveValue('Atherya Ayurveda Spa');
  await expect(page.locator('#exp-day-0')).not.toBeChecked();
  for (const d of [1, 2, 3, 4, 5, 6]) await expect(page.locator('#exp-day-' + d)).toBeChecked();
});

test('fill: never overwrites a slug or name ops already typed', async ({ page }) => {
  await boot(page, OPS, withBusiness);
  await stubBusiness(page);
  await openNew(page);
  await page.locator('#exp-slug').fill('ayurvedic-massage');
  await page.locator('#exp-name').fill('Ayurvedic massage');
  await pickBusiness(page);
  await expect(page.locator('#exp-slug')).toHaveValue('ayurvedic-massage');
  await expect(page.locator('#exp-name')).toHaveValue('Ayurvedic massage');
});

test('fill: Save waits until ops confirms Google’s partner details', async ({ page }) => {
  const calls = await boot(page, OPS, withBusiness);
  await stubBusiness(page);
  await openNew(page);
  await pickBusiness(page);
  await page.locator('#exp-summary').fill('A 90-minute massage.');
  await page.locator('#exp-price').fill('35');
  await page.locator('[data-action="expSave"]').click();
  await expect(page.locator('[data-err="biz"]')).toHaveText('Check the partner name, phone and website with the partner, then tick the box.');
  expect(calls.post).toHaveLength(0);
  await page.locator('#exp-biz-confirm').check();
  await page.locator('[data-action="expSave"]').click();
  await expect.poll(() => calls.post.length).toBe(1);
});

test('fill: Google’s photos are a link to Google Maps, for a pick and for a saved experience', async ({ page }) => {
  await boot(page, OPS, { list: (r, db) => r.fulfill(json({ experiences: db.map((e, i) => (i === 0 ? { ...e, googlePlaceId: BIZ.placeId } : e)), stats: STATS, businessSearch: true })) });
  await stubBusiness(page);
  const href = 'https://www.google.com/maps/place/?q=place_id:' + BIZ.placeId;
  await page.goto(OPS_FILE + '#experiences');
  await ready(page);
  await rows(page).nth(0).locator('[data-action="expEdit"]').click();
  await expect(page.locator('[data-testid="exp-google-photos"]')).toHaveAttribute('href', href);
  await page.locator('[data-action="expCancel"]').click();
  await rows(page).nth(1).locator('[data-action="expEdit"]').click();
  await expect(page.locator('[data-testid="exp-google-photos"]')).toBeHidden();
  await pickBusiness(page);
  await expect(page.locator('[data-testid="exp-google-photos"]')).toHaveAttribute('href', href);
  await expect(page.locator('[data-testid="exp-google-photos"]')).toHaveText('See their photos on Google Maps');
});
