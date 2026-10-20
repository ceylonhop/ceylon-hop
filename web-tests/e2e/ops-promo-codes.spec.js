import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Promo codes panel on the ops Rates page (spec docs/superpowers/specs/2026-09-28-ops-promo-codes-design.md).
// Offline, stubbed like ops-rates-page.spec.js. The founder API itself (validation, the
// PROMO_CODES_ENABLED gate, the capability) is covered server-side by api's promoCodes.test.ts —
// these pin what the page shows and exactly what it sends.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const FOUNDER = ['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act',
  'payments:reverse', 'analytics:view', 'discount:apply_manual', 'promo_codes:manage', 'rates:manage'];
// Reaches the Rates page (margin:view) but cannot manage promo codes.
const NO_PROMO = FOUNDER.filter((c) => c !== 'promo_codes:manage');

const RATES = {
  perKmCents: { car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 },
  costPerKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  floorCents: { car: 2900, van: 4999, van9: 4999, van14: 8500, custom: 11000 }, dayRateCents: 3105, dayRateCostCents: 2700,
  extrasCents: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  bufferPct: 10, fxUsdToLkr: 330,
};
const RATES_BODY = {
  live: { version: '2026-07-14', source: 'defaults', rates: RATES, createdBy: null, createdAt: null },
  defaults: { version: '2026-07-14', rates: RATES }, history: [], readOnly: { depositPct: 10, depositMinCents: 5000, depositEligibleMinCents: 15000 },
};

// Sri Lanka midnight at the start of `iso`, and the day after — how the page stores a picked day.
const slMidnight = (iso) => `${iso}T00:00:00+05:30`;
const dayAfter = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
// "31 Oct" — the list's day format, in Asia/Colombo.
const shortDay = (iso) => new Date(`${iso}T12:00:00+05:30`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Colombo' });
const past = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };

function code(over) {
  return {
    id: over.code.toLowerCase(), method: 'percentage', value: 1000, startsAt: null,
    expiresAt: slMidnight(dayAfter(futureIsoDate(30))), maxUses: 20, active: true,
    createdBy: 'x@e2e.test', createdAt: '2026-09-01T00:00:00.000Z', updatedBy: null, updatedAt: null,
    uses: { paid: 0, held: 0, remaining: 20 }, worksNow: true, ...over,
  };
}
const CODES = [
  code({ code: 'OLD-ENDED', active: false, createdAt: '2026-09-01T00:00:00.000Z', value: 500, maxUses: 1, uses: { paid: 0, held: 0, remaining: 1 } }),
  code({ code: 'ROSHEN-7KQ2', createdAt: '2026-09-20T00:00:00.000Z', uses: { paid: 3, held: 1, remaining: 16 } }),
  code({ code: 'LATER-15', value: 1500, createdAt: '2026-09-10T00:00:00.000Z', startsAt: slMidnight(futureIsoDate(10)), maxUses: 50, uses: { paid: 0, held: 0, remaining: 50 } }),
  code({ code: 'SURF-CAMP', value: 2000, createdAt: '2026-09-05T00:00:00.000Z', maxUses: 5, uses: { paid: 5, held: 0, remaining: 0 } }),
  code({ code: 'SEPT-FRIENDS', createdAt: '2026-09-03T00:00:00.000Z', expiresAt: slMidnight(past(2)), maxUses: 10, uses: { paid: 7, held: 0, remaining: 3 } }),
];

// Boots the shell on #rates. `promo` handles /admin/promo-codes and /admin/promo-codes/:id;
// every call is recorded so a test can assert exactly what was sent.
async function boot(page, caps, { promo } = {}) {
  const calls = [];
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {}, TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}) },
    };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'founder', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/rates', (r) => r.fulfill(json(RATES_BODY)));
  await page.route('**/admin/quote/zones', (r) => r.fulfill(json({ zones: [], disabled: false })));
  await page.route('**/admin/promo-codes**', async (r) => {
    const req = r.request();
    const call = { method: req.method(), path: new URL(req.url()).pathname, body: req.postDataJSON() };
    calls.push(call);
    if (promo) return promo(r, call);
    return r.fulfill(json({ codes: CODES }));
  });
  await page.goto(OPS_FILE + '#rates');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
  return calls;
}
const panel = (page) => page.locator('[data-testid="promo-panel"]');
const row = (page, c) => panel(page).locator(`[data-promo-row="${c.toLowerCase()}"]`);
const writes = (calls) => calls.filter((c) => c.method !== 'GET');

test('a role without promo_codes:manage sees no panel and never asks for codes', async ({ page }) => {
  const calls = await boot(page, NO_PROMO);
  await expect(page.locator('[data-testid="rates-page"]')).toBeVisible();
  await expect(page.locator('[data-testid="rates-page"]')).toContainText('Hot zones');
  await expect(panel(page)).toHaveCount(0);
  expect(calls).toHaveLength(0);
});

test('the list: newest first, % off, uses, dates and one status per state', async ({ page }) => {
  await boot(page, FOUNDER);
  await expect(panel(page)).toContainText('Held = an unpaid booking is reserving a use for up to 2 hours.');
  expect(await panel(page).locator('[data-promo-row]').evaluateAll((rs) => rs.map((r) => r.dataset.promoRow)))
    .toEqual(['roshen-7kq2', 'later-15', 'surf-camp', 'sept-friends', 'old-ended']);

  const active = row(page, 'ROSHEN-7KQ2');
  await expect(active).toContainText('10%');
  await expect(active).toContainText('3 paid · 1 held · 16 left of 20');
  await expect(active).toContainText('Now');
  await expect(active).toContainText(shortDay(futureIsoDate(30)));
  await expect(active.locator('.pc-chip')).toHaveText('Active');
  await expect(active.getByRole('button', { name: 'End now' })).toBeVisible();

  await expect(row(page, 'LATER-15')).toContainText(shortDay(futureIsoDate(10)));
  await expect(row(page, 'LATER-15').locator('.pc-chip')).toHaveText('Starts later');
  await expect(row(page, 'SURF-CAMP').locator('.pc-chip')).toHaveText('Used up');
  await expect(row(page, 'SEPT-FRIENDS').locator('.pc-chip')).toHaveText('Expired');
  const ended = row(page, 'OLD-ENDED');
  await expect(ended.locator('.pc-chip')).toHaveText('Ended');
  await expect(ended.getByRole('button', { name: 'Turn back on' })).toBeVisible();
  await expect(ended.getByRole('button', { name: 'End now' })).toHaveCount(0);
});

test('no codes yet says so', async ({ page }) => {
  await boot(page, FOUNDER, { promo: (r) => r.fulfill(json({ codes: [] })) });
  await expect(panel(page)).toContainText('No promo codes yet.');
});

test('create: sends Sri Lanka days, reloads the list and toasts', async ({ page }) => {
  const created = code({ code: 'SPRING-26', createdAt: '2026-09-27T00:00:00.000Z' });
  let list = CODES;
  const calls = await boot(page, FOUNDER, {
    promo: (r, call) => {
      if (call.method === 'POST') { list = [created, ...CODES]; return r.fulfill(json(created, 201)); }
      return r.fulfill(json({ codes: list }));
    },
  });
  const starts = futureIsoDate(10), ends = futureIsoDate(40);
  await page.fill('#pc-code', 'spring-26');
  await page.fill('#pc-pct', '10');
  await page.fill('#pc-uses', '20');
  await page.fill('#pc-starts', starts);
  await page.fill('#pc-ends', ends);
  await page.getByRole('button', { name: 'Create code' }).click();

  await expect(row(page, 'SPRING-26')).toBeVisible();
  await expect(page.getByText('Code SPRING-26 created')).toBeVisible();
  expect(writes(calls)).toEqual([{
    method: 'POST', path: '/admin/promo-codes',
    body: { code: 'SPRING-26', method: 'percentage', value: 1000, maxUses: 20, startsAt: slMidnight(starts), expiresAt: slMidnight(dayAfter(ends)) },
  }]);
  await expect(page.locator('#pc-code')).toHaveValue('');
});

test('create with no start date sends no startsAt', async ({ page }) => {
  const calls = await boot(page, FOUNDER, {
    promo: (r, call) => call.method === 'POST' ? r.fulfill(json(code({ code: 'NOW-5' }), 201)) : r.fulfill(json({ codes: CODES })),
  });
  const ends = futureIsoDate(20);
  await page.fill('#pc-code', 'NOW-5');
  await page.fill('#pc-pct', '5');
  await page.fill('#pc-uses', '3');
  await page.fill('#pc-ends', ends);
  await page.getByRole('button', { name: 'Create code' }).click();
  await expect.poll(() => writes(calls).length).toBe(1);
  expect(writes(calls)[0].body).toEqual({ code: 'NOW-5', method: 'percentage', value: 500, maxUses: 3, expiresAt: slMidnight(dayAfter(ends)) });
});

for (const [what, fill, message] of [
  ['a bad code shape', { code: 'A!' }, '3–32 letters, numbers or -'],
  ['0% off', { pct: '0' }, '1–30%'],
  ['31% off', { pct: '31' }, '1–30%'],
  ['0 uses', { uses: '0' }, 'At least 1'],
  ['an end before the start', { starts: futureIsoDate(20), ends: futureIsoDate(10) }, 'On or after the start'],
  ['an end in the past', { ends: past(3) }, 'Today or later'],
]) {
  test(`validation: ${what} shows a message and sends nothing`, async ({ page }) => {
    const calls = await boot(page, FOUNDER);
    const v = { code: 'GOOD-1', pct: '10', uses: '5', starts: '', ends: futureIsoDate(30), ...fill };
    await page.fill('#pc-code', v.code);
    await page.fill('#pc-pct', v.pct);
    await page.fill('#pc-uses', v.uses);
    await page.fill('#pc-starts', v.starts);
    await page.fill('#pc-ends', v.ends);
    await page.getByRole('button', { name: 'Create code' }).click();
    await expect(panel(page).locator('.pc-err')).toContainText(message);
    expect(writes(calls)).toHaveLength(0);
  });
}

test('Suggest fills a hard-to-guess code', async ({ page }) => {
  await boot(page, FOUNDER);
  await expect(panel(page)).toBeVisible();
  await page.getByRole('button', { name: 'Suggest' }).click();
  await expect(page.locator('#pc-code')).toHaveValue(/^CH-[A-HJ-NP-Z2-9]{6}$/);
});

test('edit sends only what changed; lowering uses below paid + held asks first', async ({ page }) => {
  const calls = await boot(page, FOUNDER, {
    promo: (r, call) => call.method === 'PATCH' ? r.fulfill(json(CODES[1])) : r.fulfill(json({ codes: CODES })),
  });
  const r = row(page, 'ROSHEN-7KQ2');
  await r.getByRole('button', { name: 'Edit' }).click();
  const ends = futureIsoDate(45);
  await r.locator('.pc-edit-ends').fill(ends);
  await r.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => writes(calls).length).toBe(1);
  expect(writes(calls)[0]).toEqual({ method: 'PATCH', path: '/admin/promo-codes/roshen-7kq2', body: { expiresAt: slMidnight(dayAfter(ends)) } });

  // 3 paid + 1 held: a limit of 2 asks — dismissing sends nothing, accepting sends maxUses only.
  await r.getByRole('button', { name: 'Edit' }).click();
  await r.locator('.pc-edit-uses').fill('2');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await r.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => asked).toContain('4 uses are already paid or held. Set the limit to 2 anyway?');
  expect(writes(calls)).toHaveLength(1);
  page.once('dialog', (d) => d.accept());
  await r.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => writes(calls).length).toBe(2);
  expect(writes(calls)[1].body).toEqual({ maxUses: 2 });
});

test('End now confirms first; Turn back on does not', async ({ page }) => {
  const calls = await boot(page, FOUNDER, {
    promo: (r, call) => call.method === 'PATCH' ? r.fulfill(json(CODES[1])) : r.fulfill(json({ codes: CODES })),
  });
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await row(page, 'ROSHEN-7KQ2').getByRole('button', { name: 'End now' }).click();
  await expect.poll(() => asked).toContain('End ROSHEN-7KQ2 now?');
  expect(writes(calls)).toHaveLength(0);

  page.once('dialog', (d) => d.accept());
  await row(page, 'ROSHEN-7KQ2').getByRole('button', { name: 'End now' }).click();
  await expect.poll(() => writes(calls).length).toBe(1);
  expect(writes(calls)[0]).toEqual({ method: 'PATCH', path: '/admin/promo-codes/roshen-7kq2', body: { active: false } });

  await row(page, 'OLD-ENDED').getByRole('button', { name: 'Turn back on' }).click();
  await expect.poll(() => writes(calls).length).toBe(2);
  expect(writes(calls)[1]).toEqual({ method: 'PATCH', path: '/admin/promo-codes/old-ended', body: { active: true } });
});

test('switched off on this server: the banner shows and the form disables', async ({ page }) => {
  await boot(page, FOUNDER, {
    promo: (r, call) => call.method === 'POST' ? r.fulfill(json({ error: 'promo_codes_disabled' }, 403)) : r.fulfill(json({ codes: CODES })),
  });
  await page.fill('#pc-code', 'OFF-1');
  await page.fill('#pc-pct', '10');
  await page.fill('#pc-uses', '5');
  await page.fill('#pc-ends', futureIsoDate(30));
  await page.getByRole('button', { name: 'Create code' }).click();
  await expect(panel(page)).toContainText('Promo codes are switched off on this server, so new codes can’t be created here.');
  await expect(page.getByRole('button', { name: 'Create code' })).toBeDisabled();
  await expect(page.locator('#pc-code')).toBeDisabled();
});

test('a taken code says so under the field', async ({ page }) => {
  await boot(page, FOUNDER, {
    promo: (r, call) => call.method === 'POST' ? r.fulfill(json({ error: 'code_taken' }, 409)) : r.fulfill(json({ codes: CODES })),
  });
  await page.fill('#pc-code', 'ROSHEN-7KQ2');
  await page.fill('#pc-pct', '10');
  await page.fill('#pc-uses', '5');
  await page.fill('#pc-ends', futureIsoDate(30));
  await page.getByRole('button', { name: 'Create code' }).click();
  await expect(panel(page).locator('.pc-err')).toHaveText('That code already exists.');
  await expect(page.locator('#pc-code')).toHaveValue('ROSHEN-7KQ2');
});

test('a list that fails to load offers a retry', async ({ page }) => {
  let fail = true;
  await boot(page, FOUNDER, {
    promo: (r) => fail ? r.fulfill(json({ error: 'boom' }, 500)) : r.fulfill(json({ codes: CODES })),
  });
  await expect(panel(page)).toContainText('Couldn’t load promo codes.');
  fail = false;
  await panel(page).getByRole('button', { name: 'Retry' }).click();
  await expect(row(page, 'ROSHEN-7KQ2')).toBeVisible();
});

test('a list reload mid-typing keeps the typed code', async ({ page }) => {
  await boot(page, FOUNDER, {
    promo: (r, call) => call.method === 'PATCH' ? r.fulfill(json(CODES[0])) : r.fulfill(json({ codes: CODES })),
  });
  await page.fill('#pc-code', 'HALF-TYP');
  await row(page, 'OLD-ENDED').getByRole('button', { name: 'Turn back on' }).click(); // PATCH → list reload
  await expect(row(page, 'ROSHEN-7KQ2')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('#pc-code')).toHaveValue('HALF-TYP');
});

test('phone width: the panel fits without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page, FOUNDER);
  await expect(row(page, 'ROSHEN-7KQ2')).toBeVisible();
  const overflow = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="promo-panel"]');
    return { page: document.documentElement.scrollWidth - window.innerWidth, panel: p.scrollWidth - p.clientWidth };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.panel).toBeLessThanOrEqual(0);
});
