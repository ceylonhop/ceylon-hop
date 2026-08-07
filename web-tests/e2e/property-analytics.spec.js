import { test, expect } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────────────────
//  Analytics on the properties that shipped after Phase 0 — pay, quote, manage (2026-08-07).
//
//  Each of these pages carried the GTM loader, which made them LOOK instrumented. None of
//  them pushed a single event, and pay/quote never granted consent at all, so Clarity never
//  recorded one payment and GA4 saw only cookieless pings. These assert the dataLayer that
//  the funnel and the session replay are actually built on.
//
//  Behavioural, not source-shape: the point of a payment funnel is that it fires on the real
//  branches, and the pay page's branches are mid-flight states a grep cannot reach.
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const TOTALS = { cents: 49885, usd: '$498.85', lkr: 'LKR 164,620' };
const COPY = {
  product: 'single', greetingName: 'Emma',
  title: 'Colombo Airport (CMB) → Galle',
  subtitle: 'Saturday 8 August 2026',
  facts: [{ k: 'Travellers', v: '2' }],
  legs: null,
  includedText: 'Driver, fuel and highway tolls.',
  totalLabel: 'Total',
};
const PREFILL = { firstName: 'Nimal', lastName: 'Perera', email: '', whatsapp: '+94770001111', country: '' };

// Keep the suite offline: GTM never loads here, so `dataLayer` stays a plain array of exactly
// what the page pushed — which is the thing under test.
async function offline(page) {
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://www.payhere.lk/lib/**', (r) => r.abort());
}

// The head also pushes gtag('consent','default',…) as an arguments object, and GTM pushes
// gtm.js — neither is ours. `layer` keeps only the named events the site itself tracks.
const layer = (page) =>
  page.evaluate(() =>
    (window.dataLayer || [])
      .filter((e) => e && !e.length && e.event && e.event !== 'gtm.js')
      .map((e) => ({ ...e })));
const eventNames = async (page) => (await layer(page)).map((e) => e.event);
const find = async (page, name) => (await layer(page)).find((e) => e.event === name);

// Consent is remembered per origin; grant it up front so the pages behave as they do for a
// customer who has already accepted, and the strip is out of the way of the clicks below.
async function preConsented(page) {
  await page.addInitScript(() => localStorage.setItem('ceylonhop_consent', 'granted'));
}

// Pretend we are on a revenue host. chIsProd() is correctly false on localhost, and it gates
// `purchase` — so a test about purchase has to say so out loud rather than quietly passing
// because nothing fired. Installed before any page script; the no-op setter absorbs
// analytics.js's own assignment when it loads.
async function forceProdHost(page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'chIsProd', {
      configurable: true,
      get: () => () => true,
      set: () => {},
    });
  });
}

// ── the context every property publishes ────────────────────────────────────────────────

test('every property announces itself before anything else', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  for (const [url, property] of [
    ['/pay.html?t=tok', 'pay'],
    ['/quote.html?q=tok', 'quote'],
    ['/manage.html?t=tok', 'manage'],
    ['/board.html', 'board'],
    ['/index.html', 'site'],
  ]) {
    await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ state: 'payable', copy: COPY, totals: TOTALS, prefill: PREFILL }) }));
    await page.route('**/quote-view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ state: 'unavailable' }) }));
    await page.route('**/bookings/view*', (r) => r.fulfill({ status: 404, body: '{}' }));
    await page.goto(url);
    const first = (await layer(page))[0];
    expect(first, `${url} pushed nothing`).toBeTruthy();
    expect(first.event, `${url} did not lead with ch_context`).toBe('ch_context');
    expect(first.ch_property, `${url} reported the wrong property`).toBe(property);
    // The test server is localhost, so this is the honest answer — and it is what keeps
    // local and staging traffic out of the production funnel.
    expect(first.ch_env).toBe('dev');
  }
});

// ── pay.html: the money path ─────────────────────────────────────────────────────────────

async function payable(page) {
  await offline(page);
  await preConsented(page);
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'payable', copy: COPY, totals: TOTALS, prefill: PREFILL }) }));
}

test('opening a live pay link reports the state and the amount on the line', async ({ page }) => {
  await payable(page);
  await page.goto('/pay.html?t=test-token');
  await expect(page.locator('#paybtn')).toBeVisible();

  const opened = await find(page, 'pay_link_opened');
  expect(opened).toMatchObject({ state: 'payable', value: 498.85, currency: 'USD' });
  // The ticket being SEEN is a separate fact from the link being opened: a link that resolves
  // to a dead quote reaches the first and never the second.
  expect(await find(page, 'view_item')).toMatchObject({ value: 498.85, item_category: 'single' });
});

test('a pay link that has already been paid is counted, and never as a purchase', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'paid', paid: { reference: 'CH-TEST1', firstName: 'Nimal', facts: [] } }) }));
  await page.goto('/pay.html?t=test-token');
  await expect(page.locator('.st-title')).toContainText('booked');

  expect(await find(page, 'pay_link_opened')).toMatchObject({ state: 'paid' });
  // Re-opening the receipt is not a second sale. This is the difference between a funnel and
  // a revenue figure that grows every time a customer re-reads their confirmation.
  expect(await eventNames(page)).not.toContain('purchase');
});

test('a dead API is reported rather than disguised as an expired link', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  const beacons = [];
  await page.route('**/errors/client', (r) => { beacons.push(r.request().postDataJSON()); return r.fulfill({ status: 204 }); });
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await page.goto('/pay.html?t=test-token');
  await expect(page.locator('.de-title, .st-title')).toBeVisible();

  // The customer still gets the gentle dead-end...
  expect(await find(page, 'pay_link_opened')).toMatchObject({ state: 'error' });
  // ...and we get told, tagged with the property, which is what was missing.
  await expect.poll(() => beacons.length).toBeGreaterThan(0);
  expect(beacons[0].property).toBe('pay');
  expect(beacons[0].message).toContain('[pay] view failed');
});

test('the funnel records which field turned a payer away', async ({ page }) => {
  await payable(page);
  await page.goto('/pay.html?t=test-token');
  await page.locator('#paybtn').click();
  expect(await find(page, 'begin_checkout')).toMatchObject({ value: 498.85 });

  // Straight at Continue with an empty billing address.
  await page.locator('#f-terms').check();
  await page.locator('#gobtn').click();
  await expect(page.locator('#payerr')).toContainText('address');

  const invalid = (await layer(page)).filter((e) => e.event === 'pay_form_invalid');
  expect(invalid).toHaveLength(1);
  expect(invalid[0].reason).toBe('address');
  // A payer who gives up at billing and one who never ticked the terms are different
  // problems; the reason keyword is what separates them. It is never what they typed.
  expect(JSON.stringify(invalid[0])).not.toContain('Nimal');
});

test('the hand-off to the gateway is the last thing we can honestly claim', async ({ page }) => {
  await payable(page);
  await page.route('**/quotes/pay/start', (r) => r.fulfill({ status: 201, contentType: 'application/json',
    body: JSON.stringify({ bookingId: 'b-1', checkoutToken: 'ct-1' }) }));
  await page.route('**/bookings/b-1/checkout', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: { order_id: 'o-1' } }) }));
  await page.route('https://sandbox.payhere.lk/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stub</h1>' }));

  await page.goto('/pay.html?t=test-token');
  await page.locator('#paybtn').click();
  await page.locator('#f-addr').fill('31 River Court');
  await page.locator('#f-city').fill('Jersey City');
  await page.locator('#f-terms').check();

  const names = [];
  page.on('console', () => {});
  // Capture the layer before the navigation takes the page away with it.
  await page.exposeFunction('__capture', (n) => names.push(n));
  await page.evaluate(() => {
    const push = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = (e) => { if (e && e.event) window.__capture(e.event); return push(e); };
  });
  await page.locator('#gobtn').click();
  await page.waitForURL(/sandbox\.payhere\.lk/);

  expect(names).toContain('add_payment_info');
  expect(names).toContain('payment_initiated');
  // In that order: details accepted, THEN we leave. A page that reported the hand-off before
  // the server had accepted the details would show a cliff that isn't there.
  expect(names.indexOf('add_payment_info')).toBeLessThan(names.indexOf('payment_initiated'));
});

test('a refusal at our own door names itself instead of counting as a decline', async ({ page }) => {
  await payable(page);
  await page.route('**/quotes/pay/start', (r) => r.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'quote_revised' }) }));
  await page.goto('/pay.html?t=test-token');
  await page.locator('#paybtn').click();
  await page.locator('#f-addr').fill('31 River Court');
  await page.locator('#f-city').fill('Jersey City');
  await page.locator('#f-terms').check();
  await page.locator('#gobtn').click();

  await expect.poll(() => find(page, 'payment_start_failed')).toBeTruthy();
  expect(await find(page, 'payment_start_failed')).toMatchObject({ reason: 'quote_revised' });
  // The gateway was never reached, so nothing may claim the bank refused anything.
  expect(await eventNames(page)).not.toContain('payment_failed');
});

test('a real settlement reports a purchase once, with the amount it actually cost', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'paid', paid: { reference: 'CH-TEST1', firstName: 'Nimal', facts: [] } }) }));
  await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'paid', reference: 'CH-TEST1' }) }));
  // The tab remembers the quote AND what it cost — /view has not run on this leg, so without
  // the stash a real payment would report a value of zero. `sandbox: '0'` = a live gateway.
  await page.addInitScript(() => {
    sessionStorage.setItem('ch_pay_v1', JSON.stringify({ t: 'test-token', typed: null, cents: 49885 }));
    sessionStorage.setItem('ch_pay_v1:sandbox', '0');
  });
  // chIsProd() is false on localhost by design, and the return leg polls the moment the page
  // loads — so the stub has to be in place BEFORE analytics.js runs, not after goto(). The
  // setter swallows analytics.js's own assignment.
  await forceProdHost(page);
  await page.goto('/pay.html?rt=return-token-1');

  await expect(page.locator('.st-title')).toContainText('booked');
  await expect.poll(async () => (await eventNames(page)).filter((n) => n === 'purchase').length)
    .toBeGreaterThan(0);
  const purchase = await find(page, 'purchase');
  expect(purchase).toMatchObject({ transaction_id: 'CH-TEST1', value: 498.85, currency: 'USD' });
});

test('a sandbox settlement never becomes revenue', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'paid', paid: { reference: 'CH-SBX', firstName: 'Nimal', facts: [] } }) }));
  await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'paid', reference: 'CH-SBX' }) }));
  await page.addInitScript(() => {
    sessionStorage.setItem('ch_pay_v1', JSON.stringify({ t: 'test-token', typed: null, cents: 49885 }));
    sessionStorage.setItem('ch_pay_v1:sandbox', '1');   // handed off to the SANDBOX gateway
  });
  await forceProdHost(page);   // ...and even so, on a host that IS production
  await page.goto('/pay.html?rt=return-token-1');
  await expect(page.locator('.st-title')).toContainText('booked');

  // GA4 cannot delete events after the fact, so this gate is the difference between a revenue
  // figure and a revenue figure with test money in it, permanently.
  expect(await eventNames(page)).not.toContain('purchase');
});

test('a decline on the way back is reported with the leg it came in on', async ({ page }) => {
  await payable(page);
  await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'failed', reference: 'CH-TEST1' }) }));
  await page.addInitScript(() => {
    sessionStorage.setItem('ch_pay_v1', JSON.stringify({ t: 'test-token', typed: null, cents: 49885 }));
  });
  // `c=1` is PayHere's cancel leg — and the owner watched a real DECLINE arrive on it
  // (2026-08-05), which is why the leg has to stay visible in reporting.
  await page.goto('/pay.html?rt=return-token-1&c=1');
  await expect(page.locator('#payerr')).toBeVisible();

  const failed = await find(page, 'payment_failed');
  expect(failed).toMatchObject({ leg: 'cancel', value: 498.85 });
});

test('the silent middle — no verdict at all — finally has a name', async ({ page }) => {
  await payable(page);
  // Our server never reaches a terminal answer within the cancel-leg budget. This is the state
  // behind the `pending` rows: not a decline, not a sale, and until now not in any report.
  await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'pending' }) }));
  await page.addInitScript(() => {
    sessionStorage.setItem('ch_pay_v1', JSON.stringify({ t: 'test-token', typed: null, cents: 49885 }));
  });
  await page.goto('/pay.html?rt=return-token-1&c=1');

  await expect.poll(() => find(page, 'payment_cancelled'), { timeout: 30000 }).toBeTruthy();
  const ev = await find(page, 'payment_cancelled');
  expect(ev.leg).toBe('cancel');
  expect(ev.tries).toBeGreaterThan(1);
  expect(ev.value).toBe(498.85);
});

// ── quote.html: the proposal ─────────────────────────────────────────────────────────────

const QOPT = (service, name, totalCents, lead) => ({
  service, name, blurb: `${name} blurb.`, includedText: 'Everything included.',
  totalCents, totalUsd: `$${(totalCents / 100).toFixed(0)}`, deltaUsd: null, deltaText: null,
  cancellation: { headline: 'Free cancellation until 24 hours before.', ladder: ['Full refund.'] },
  lead, waText: `Hi! I'd like the ${name} option for quote Q-E2E77`,
});
const QVIEW = (options) => ({
  reference: 'Q-E2E77', greetingName: 'Anna', title: 'Colombo Airport → Ella',
  subtitle: '3-day private trip · 2 travellers',
  heroTotalUsd: options[0].totalUsd, heroTotalNote: options[0].name.toLowerCase(),
  days: [{ kind: 'journey', date: 'MON 10 AUG', title: 'Colombo Airport → Kandy', meta: '120 km', stops: [] }],
  mapStops: [], totalKm: 260, travelDays: 1, options,
  waText: 'Hi! I have a question about quote Q-E2E77',
});

async function stubQuote(page, body) {
  await offline(page);
  await preConsented(page);
  await page.route('**/quote-view*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
}

test('a live quote reports both options and their prices', async ({ page }) => {
  const options = [QOPT('private', 'Private transfers', 45000, true), QOPT('chauffeur', 'Chauffeur-guide', 61000, false)];
  await stubQuote(page, { state: 'live', view: QVIEW(options), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() });
  await page.goto('/quote.html?t=test-token');
  await expect(page.locator('.opts .ticket').first()).toBeVisible();

  expect(await find(page, 'quote_link_opened')).toMatchObject({ state: 'live' });
  const list = await find(page, 'view_item_list');
  expect(list.items).toHaveLength(2);
  expect(list.items[0]).toMatchObject({ item_id: 'private', price: 450 });
  expect(list.items[1]).toMatchObject({ item_id: 'chauffeur', price: 610 });
  expect(list.lapsed).toBe(false);
});

test('tapping an option says WHICH one, not just that WhatsApp was opened', async ({ page }) => {
  const options = [QOPT('private', 'Private transfers', 45000, true), QOPT('chauffeur', 'Chauffeur-guide', 61000, false)];
  await stubQuote(page, { state: 'live', view: QVIEW(options), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() });
  await page.goto('/quote.html?t=test-token');

  // Don't actually leave for WhatsApp; the click is what we're measuring.
  await page.locator('.opts .ticket').nth(1).locator('a.pp-cta')
    .evaluate((a) => { a.removeAttribute('href'); a.click(); });

  const sel = await find(page, 'select_item');
  expect(sel.items[0]).toMatchObject({ item_id: 'chauffeur', price: 610 });
  // The delegated contact_whatsapp listener could only ever say "someone tapped a wa.me link".
  // Which of the two ways to travel they chose is the question this page exists to answer.
  expect(sel.item_list_id).toBe('customer_quote');
});

test('an expired price is reported as expired, not as an ordinary view', async ({ page }) => {
  const options = [QOPT('private', 'Private transfers', 45000, true)];
  await stubQuote(page, { state: 'lapsed', view: QVIEW(options), validUntil: new Date(Date.now() - 864e5).toISOString() });
  await page.goto('/quote.html?t=test-token');
  await expect(page.locator('.lapse')).toBeVisible();

  expect(await find(page, 'quote_link_opened')).toMatchObject({ state: 'lapsed' });
  expect(await find(page, 'quote_lapsed_shown')).toBeTruthy();
  // How often a customer opens a quote only after the price has gone stale is a measure of
  // how fast ops needs to follow up. It had no number at all before.
  expect((await find(page, 'view_item_list')).lapsed).toBe(true);
});

test('a broken quote API is reported, not disguised as a dead link', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  const beacons = [];
  await page.route('**/errors/client', (r) => { beacons.push(r.request().postDataJSON()); return r.fulfill({ status: 204 }); });
  await page.route('**/quote-view*', (r) => r.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));
  await page.goto('/quote.html?t=test-token');
  await expect(page.locator('.de-title')).toBeVisible();

  expect(await find(page, 'quote_link_opened')).toMatchObject({ state: 'error' });
  await expect.poll(() => beacons.length).toBeGreaterThan(0);
  expect(beacons[0].property).toBe('quote');
});

// ── manage.html: the booking a customer comes back to ────────────────────────────────────

const BOOKING = {
  reference: 'CH-HAFDZ', status: 'payment_pending', firstName: 'Roshen',
  from: 'Colombo Airport (CMB)', to: 'Batticaloa, Sri Lanka', date: '2026-07-22', time: null,
  travellers: 2, vehicleType: 'car', totalCents: 22900, balanceDueCents: 0,
  amountDueNowCents: 22900, currency: 'USD',
};

test('opening a booking reports its status and whether money is still owed', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  await page.route('**/bookings/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOOKING) }));
  await page.route('https://www.payhere.lk/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.payhere={startPayment:function(){}};' }));
  await page.goto('/manage.html?t=test-token');
  await expect(page.locator('.t-ref')).toHaveText('Booking CH-HAFDZ');

  expect(await find(page, 'manage_opened')).toMatchObject({
    status: 'payment_pending', has_balance: false, value: 229, currency: 'USD',
  });
  // The reference is a transaction id, not a name — but nothing here may carry the customer's.
  expect(JSON.stringify(await layer(page))).not.toContain('Roshen');
});

test('an expired booking link is counted with the reason it failed', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  await page.route('**/bookings/view*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.goto('/manage.html?t=stale-token');
  await expect(page.locator('#app')).toContainText('isn’t valid');

  expect(await find(page, 'manage_link_invalid')).toMatchObject({ reason: 'unauthorised' });
});

// ── what a session replay is allowed to show ─────────────────────────────────────────────

test('the customer’s name is masked from replays; the trip is not', async ({ page }) => {
  // Clarity's default masking covers form INPUTS, not rendered text — so "Hi Emma," would sit
  // in plain sight in every recording. The trip, the prices and the layout stay visible,
  // because a replay you cannot read answers nothing.
  await payable(page);
  await page.goto('/pay.html?t=test-token');
  await expect(page.locator('.pp-hello')).toHaveText('Hi Emma,');
  await expect(page.locator('.pp-hello')).toHaveAttribute('data-clarity-mask', 'true');
  // The itinerary and the amount are deliberately NOT masked.
  await expect(page.locator('.pp-title')).not.toHaveAttribute('data-clarity-mask', 'true');
  await expect(page.locator('.tot .v')).not.toHaveAttribute('data-clarity-mask', 'true');
});

test('the paid keepsake masks the guest, not the booking reference', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'paid', paid: {
      reference: 'CH-TEST1', firstName: 'Nimal', leadName: 'Nimal Perera', amountUsd: '$498.85', facts: [],
    } }) }));
  await page.goto('/pay.html?t=test-token');
  await expect(page.locator('.st-title')).toContainText('booked');

  await expect(page.locator('.st-title')).toHaveAttribute('data-clarity-mask', 'true');
  // The reference is the join key from a replay back to the order — masking it would make
  // every recording anonymous in the unhelpful sense.
  await expect(page.locator('.ref')).toHaveText('CH-TEST1');
  await expect(page.locator('.ref')).not.toHaveAttribute('data-clarity-mask', 'true');
});

test('the manage and quote greetings are masked too', async ({ page }) => {
  await offline(page);
  await preConsented(page);
  await page.route('**/bookings/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOOKING) }));
  await page.route('https://www.payhere.lk/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.payhere={startPayment:function(){}};' }));
  await page.goto('/manage.html?t=test-token');
  await expect(page.locator('.pp-hello')).toHaveAttribute('data-clarity-mask', 'true');

  await stubQuote(page, { state: 'live', view: QVIEW([QOPT('private', 'Private transfers', 45000, true)]), validUntil: new Date(Date.now() + 7 * 864e5).toISOString() });
  await page.goto('/quote.html?t=test-token');
  await expect(page.locator('.pp-hello')).toHaveText('Hi Anna,');
  await expect(page.locator('.pp-hello')).toHaveAttribute('data-clarity-mask', 'true');
});

// ── consent: the fix that makes all of the above collectable ─────────────────────────────

// Reads the real module off the static server and flips the owner switch, so the strip's
// tests exercise the SHIPPED file rather than a second copy that could drift from it.
async function forceAsk(page) {
  await page.route('**/consent-transactional.js', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('var ASK_FIRST = false;', 'var ASK_FIRST = true;');
    if (!body.includes('var ASK_FIRST = true;')) throw new Error('ASK_FIRST switch not found');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
}

async function payablePage(page) {
  await offline(page);
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'payable', copy: COPY, totals: TOTALS, prefill: PREFILL }) }));
}

const consentUpdates = (page) =>
  page.evaluate(() =>
    (window.dataLayer || [])
      .map((e) => Array.from(e && e.length !== undefined ? e : []))
      .filter((a) => a[0] === 'consent' && a[1] === 'update')
      .map((a) => a[2]));

test('the pay page measures on arrival, and shows the payer nothing at all', async ({ page }) => {
  // Owner call 2026-08-07: ASK_FIRST = false. This is the SHIPPED behaviour — no floating
  // card (the 2026-08-01 objection), no strip either, and analytics granted so Clarity can
  // finally record a payment. The old test here asserted only that consent.js's card was
  // absent, which was true while nothing was being measured at all.
  await payablePage(page);
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto('/pay.html?t=test-token');
  await expect(page.locator('#paybtn')).toBeVisible();

  await expect(page.locator('#ch-consent')).toHaveCount(0);     // consent.js's card stays gone
  await expect(page.locator('.ch-tconsent')).toHaveCount(0);    // ...and nothing replaced it
  // Nothing rendered means nothing reserved space either.
  expect(await page.evaluate(() => document.body.style.paddingBottom)).toBe('');

  const consent = await consentUpdates(page);
  expect(consent).toHaveLength(1);
  expect(consent[0].analytics_storage).toBe('granted');
  // The entire basis for not asking is that this is first-party measurement with no
  // advertising attached. An ad key here would remove that argument.
  expect(consent[0].ad_storage).toBeUndefined();
  expect(consent[0].ad_user_data).toBeUndefined();
  expect(consent[0].ad_personalization).toBeUndefined();
});

test('a customer who already refused is still not measured', async ({ page }) => {
  // manage.html shares this storage key on the apex via consent.js, so a stored refusal is a
  // real person's answer. The switch may skip ASKING; it must never overrule a decision.
  await payablePage(page);
  await page.addInitScript(() => localStorage.setItem('ceylonhop_consent', 'denied'));
  await page.goto('/pay.html?t=test-token');
  await expect(page.locator('#paybtn')).toBeVisible();
  expect(await consentUpdates(page)).toHaveLength(0);
});

// ── the strip, kept green for the day the owner flips the switch ──────────────────────────
// "False, revisit when we're larger" — so these run against the real file with ASK_FIRST
// rewritten to true. Without them the flip becomes a rediscovery instead of a one-word change.

test('[ASK_FIRST] the strip asks without ever covering the CTA', async ({ page }) => {
  // The owner's original objection was the OVERLAY: consent.js floats a card that landed on
  // "Pay with PayHere" on a phone. This strip reserves its own height instead, and that —
  // not the presence of an ask — is the invariant under test.
  await payablePage(page);
  await forceAsk(page);
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto('/pay.html?t=test-token');

  await expect(page.locator('#ch-consent')).toHaveCount(0);
  const strip = page.locator('.ch-tconsent');
  await expect(strip).toBeVisible();

  const cta = page.locator('#paybtn');
  await cta.scrollIntoViewIfNeeded();
  const [c, s] = [await cta.boundingBox(), await strip.boundingBox()];
  const overlaps = c.y < s.y + s.height && s.y < c.y + c.height;
  expect(overlaps, 'the consent strip is sitting on the pay button').toBe(false);
  await expect(cta).toBeInViewport();

  // ...and nothing is granted until they answer.
  expect(await consentUpdates(page)).toHaveLength(0);
});

test('[ASK_FIRST] accepting grants analytics and nothing else', async ({ page }) => {
  await payablePage(page);
  await forceAsk(page);
  await page.goto('/pay.html?t=test-token');
  await page.locator('.ch-tconsent [data-consent="granted"]').click();

  await expect(page.locator('.ch-tconsent')).toHaveCount(0);
  const consent = await consentUpdates(page);
  expect(consent).toHaveLength(1);
  expect(consent[0].analytics_storage).toBe('granted');
  expect(consent[0].ad_storage).toBeUndefined();
  expect(consent[0].ad_personalization).toBeUndefined();
});

test('[ASK_FIRST] the choice carries across properties, so a quote and its payment are one session', async ({ page }) => {
  // Separate ORIGINS, so localStorage does not travel. Without the hand-off a customer is
  // asked twice and the two hops look like two cold sessions with a referral in between.
  await payablePage(page);
  await forceAsk(page);
  await page.goto('/pay.html?t=test-token&chc=1');
  await expect(page.locator('#paybtn')).toBeVisible();
  await expect(page.locator('.ch-tconsent')).toHaveCount(0);
  const consent = await consentUpdates(page);
  expect(consent[0]?.analytics_storage).toBe('granted');
});
