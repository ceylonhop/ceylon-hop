import { test, expect } from '@playwright/test';

// pay.html — the customer side of quote payment links (spec D8–D10). Offline: the page's
// /quotes/pay/* calls are stubbed, so these run in the default suite with no API.
// Serial + act-then-verify, the ops-trip-calendar lessons.

test.describe.configure({ mode: 'serial' });

const PAGE = '/pay.html?t=test-token';

const COPY = {
  single: {
    product: 'single', greetingName: 'Emma',
    title: 'Colombo Airport (CMB) → Galle',
    subtitle: 'Saturday 8 August 2026',
    facts: [{ k: 'Travellers', v: '2' }, { k: 'Vehicle', v: 'Private car' }],
    legs: null,
    includedText: 'Driver, fuel and highway tolls. Airport pickup with a name board.',
    totalLabel: 'Total',
  },
  multi: {
    product: 'multi', greetingName: 'Sofia',
    title: 'Six journeys, 3–14 September', subtitle: 'Private car · 2 travellers',
    facts: [],
    legs: [
      { route: 'Colombo Airport (CMB) → Negombo', date: 'THU 3 SEP' },
      { route: 'Negombo → Sigiriya', date: 'SAT 5 SEP' },
      { route: 'Sigiriya → Kandy', date: 'MON 7 SEP' },
      { route: 'Kandy → Ella', date: 'WED 9 SEP' },
      { route: 'Ella → Mirissa', date: 'FRI 11 SEP' },
      { route: 'Mirissa → Colombo Airport (CMB)', date: 'MON 14 SEP' },
    ],
    includedText: 'Driver, fuel and tolls on every journey.',
    totalLabel: 'Total · all 6 journeys',
  },
  chauffeur: {
    product: 'chauffeur', greetingName: 'Nimal',
    title: 'Six days across Sri Lanka', subtitle: '12–17 August · your own van & driver',
    facts: [
      { k: 'Trip', v: 'Colombo Airport (CMB) → Galle', sub: 'full day-by-day plan in your quote' },
      { k: 'Days', v: '6 with your driver', sub: 'including your free days' },
      { k: 'Travellers', v: '4 · Van' },
      { k: 'Starts', v: 'Wed 12 Aug' },
    ],
    legs: null,
    includedText: 'Vehicle & English-speaking driver for all 6 days.',
    totalLabel: 'Total · 6 days',
  },
};

const TOTALS = { cents: 49885, usd: '$498.85', lkr: 'LKR 164,620' };
const PREFILL = { firstName: 'Nimal', lastName: 'Perera', email: '', whatsapp: '+94770001111', country: '' };

async function stubView(page, body) {
  await page.route('**/quotes/pay/view*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  // The page also loads GTM/analytics; keep the suite offline-quiet.
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://www.payhere.lk/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.payhere={startPayment:function(){}};' }));
}

test('single transfer: ticket, exact button copy, reassurance line', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await expect(page.locator('.pp-title')).toHaveText('Colombo Airport (CMB) → Galle');
  await expect(page.locator('.pp-hello')).toContainText('Hi Emma');
  await expect(page.locator('#paybtn')).toHaveText('Pay with PayHere'); // exact copy, spec D10
  await expect(page.locator('.paysub')).toContainText('Pay securely to confirm. $498.85 — no extra fees.');
  await expect(page.locator('.tot .v')).toHaveText('$498.85');
  await expect(page.locator('.hop')).toHaveCount(0);
});

test('multi-leg: every journey listed, one row each, no prices in the rows', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.multi, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await expect(page.locator('.hop')).toHaveCount(6);
  await expect(page.locator('.hop').first()).toContainText('Colombo Airport (CMB) → Negombo');
  await expect(page.locator('.hop').first()).toContainText('THU 3 SEP');
  await expect(page.locator('.hops')).not.toContainText('$'); // legs never carry prices
  await expect(page.locator('.tot .l')).toHaveText('Total · all 6 journeys');
});

test('chauffeur: the four shape facts, never a leg list', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.chauffeur, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await expect(page.locator('.fact .k')).toHaveText(['Trip', 'Days', 'Travellers', 'Starts']);
  await expect(page.locator('.fact').nth(1)).toContainText('6 with your driver');
  await expect(page.locator('.hop')).toHaveCount(0);
});

test('the details step uses the wizard widget: country code select + local number', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.chauffeur, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await expect(page.locator('#f-firstName')).toHaveValue('Nimal');
  // "+94770001111" prefill splits into the LK dial code + a LOCAL number, like booking.html.
  await expect(page.locator('#f-country')).toHaveValue('Sri Lanka');
  await expect(page.locator('#f-phone')).toHaveValue('770001111');
  await expect(page.locator('#f-email')).toHaveValue('');
  await expect(page.locator('#f-email')).toBeFocused(); // first empty field
  await expect(page.locator('#gobtn')).toHaveText('Continue to payment');
  // The select shows dial codes the way the wizard does.
  await expect(page.locator('#f-country option').first()).toContainText('+94');
});

test('paid: keepsake with reference, no way to pay again', async ({ page }) => {
  // The keepsake is booking.html's boarding pass (owner, 2026-08-02) — same CSS, now shared
  // from site.css, same markup rebuilt as a template string.
  await stubView(page, { state: 'paid', paid: {
    reference: 'CH-4J2QP', firstName: 'Nimal', amountUsd: '$498.85',
    title: 'Six days across Sri Lanka', from: null, to: null, leadName: 'Nimal Perera',
    facts: [{ k: 'Days', v: '6 with your driver' }, { k: 'Travellers', v: '4 · Van' }, { k: 'Starts', v: 'Wed 12 Aug' }],
  } });
  await page.goto(PAGE);
  await expect(page.locator('.st-title')).toContainText('You’re booked, Nimal');
  await expect(page.locator('.pass-stub .ref')).toHaveText('CH-4J2QP');
  await expect(page.locator('#paybtn')).toHaveCount(0);
  await expect(page.locator('.next')).toContainText('What happens next');
  // The pass is a real pass, not a styled div: the tear-off stub and barcode are what make it
  // read as one, and they come from site.css — proving the shared stylesheet actually applies.
  await expect(page.locator('.pass .barcode')).toBeVisible();
  await expect(page.locator('.pass-info')).toContainText('Nimal Perera');
  await expect(page.locator('.pass-info')).toContainText('$498.85');
  await expect(page.locator('.pass-info')).toContainText('4 · Van');
});

test('paid: a named route renders as two endpoints; a multi-journey trip does not', async ({ page }) => {
  await stubView(page, { state: 'paid', paid: {
    reference: 'CH-0001', firstName: 'Emma', amountUsd: '$39.00',
    title: 'Colombo Airport (CMB) → Galle', from: 'Colombo Airport (CMB)', to: 'Galle',
    leadName: 'Emma Stone', facts: [{ k: 'Travellers', v: '2' }],
  } });
  await page.goto(PAGE);
  await expect(page.locator('.pass-route .pt').first()).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('.pass-route .pt').last()).toContainText('Galle');
  await expect(page.locator('.pass-route .dash')).toHaveCount(1);
});

test('paid: cells the quote never stated are omitted, not filled with "To confirm"', async ({ page }) => {
  // A pay link records no departure time (start passes `time: undefined`), and booking.html's
  // pass has a "Departs" cell. Printing "To confirm" into a keepsake is worse than not having
  // the row — so the row is not there.
  await stubView(page, { state: 'paid', paid: {
    reference: 'CH-0002', firstName: 'Sam', amountUsd: '$39.00', title: 'A → B',
    from: 'A', to: 'B', leadName: null, facts: [],
  } });
  await page.goto(PAGE);
  await expect(page.locator('.pass-info')).not.toContainText('Departs');
  await expect(page.locator('.pass-info')).not.toContainText('To confirm');
  await expect(page.locator('.pass-info')).not.toContainText('Lead guest');
  await expect(page.locator('.pass-info')).toContainText('Paid'); // the ones we DO have still show
});

test('revised and unavailable share the sailed-off screen: facts, WhatsApp, no leak', async ({ page }) => {
  for (const state of ['revised', 'unavailable']) {
    await page.unrouteAll();
    await stubView(page, { state });
    await page.goto(PAGE);
    // The 404-sibling screen (spec 2026-07-31): eyebrow → pun headline → lead → WhatsApp.
    await expect(page.locator('.de-eyebrow')).toContainText('no longer active');
    await expect(page.locator('h1.de-title')).toContainText('This quote has sailed off somewhere sunny');
    await expect(page.locator('.de-lead')).toContainText('Nothing has been charged');
    await expect(page.locator('a.btn-wa')).toHaveAttribute('href', 'https://wa.me/94779669662');
    await expect(page.locator('svg.de-art')).toBeVisible(); // the boat scene
    await expect(page.locator('#paybtn')).toHaveCount(0);   // never re-offer Pay
    // Privacy: a dead-end must not leak quote data the API deliberately withholds.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('$');
    expect(body).not.toContain('LKR');
  }
});

test('sailed-off screen animation is guarded for reduced motion', async ({ page }) => {
  await stubView(page, { state: 'unavailable' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(PAGE);
  const anim = await page.locator('svg.de-art .sail').first()
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe('none');
});

test('continuing keeps the form on screen with a pending button; a failure restores it', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.chauffeur, totals: TOTALS, prefill: PREFILL });
  // /start answers slowly, then with a named-field error — long enough for the pending
  // state to be assertable, honest enough to exercise the recovery path. Owner call
  // (2026-08-01): the full-screen interstitial must NOT appear during the start/checkout
  // round-trips — on a cold API that blocked the customer behind a takeover for seconds.
  await page.route('**/quotes/pay/start', async (r) => {
    await new Promise((res) => setTimeout(res, 600));
    await r.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ error: 'bad_request', message: 'customer.email: Invalid email' }) });
  });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await page.locator('#f-email').fill('nimal@@typo');
  // Billing is required since 2026-08-01 — fill it so this reaches the /start round-trip,
  // which is what this test is actually about.
  await page.locator('#f-addr').fill('Prinsengracht 263');
  await page.locator('#f-city').fill('Amsterdam');
  await page.locator('#f-postcode').fill('1016 GV'); // required since 2026-08-02
  await page.locator('#f-bcountry').selectOption('Netherlands');
  await page.locator('#f-terms').check(); // required since 2026-08-01
  await page.locator('#gobtn').click();

  // While the API works: the FORM stays put, the button carries the wait — no takeover.
  await expect(page.locator('#gobtn')).toBeDisabled();
  await expect(page.locator('#gobtn')).toHaveText('Opening secure payment…');
  await expect(page.locator('#f-email')).toBeVisible();
  await expect(page.locator('.pp-loading')).toHaveCount(0);

  // The failure re-arms the same form WITH what the customer typed, plus the error.
  await expect(page.locator('#gobtn')).toBeEnabled();
  await expect(page.locator('#gobtn')).toHaveText('Continue to payment');
  await expect(page.locator('#f-email')).toHaveValue('nimal@@typo');
  await expect(page.locator('#f-phone')).toHaveValue('770001111'); // the fixture's prefill, kept
  await expect(page.locator('#payerr')).toContainText('email');
});

test('the interstitial appears only when the PayHere window actually opens', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.chauffeur, totals: TOTALS, prefill: PREFILL });
  await page.route('**/quotes/pay/start', (r) => r.fulfill({ status: 201, contentType: 'application/json',
    body: JSON.stringify({ bookingId: 'b-1', checkoutToken: 'ct-1' }) }));
  await page.route('**/bookings/b-1/checkout', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout', fields: { order_id: 'o-1' } }) }));
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await page.locator('#f-addr').fill('Prinsengracht 263'); // billing is required since 2026-08-01
  await page.locator('#f-city').fill('Amsterdam');
  await page.locator('#f-postcode').fill('1016 GV'); // required since 2026-08-02
  await page.locator('#f-bcountry').selectOption('Netherlands');
  await page.locator('#f-terms').check(); // required since 2026-08-01
  await page.locator('#gobtn').click();
  // payhere.startPayment is the page-load stub (a no-op): the popup "opened", so the
  // interstitial must now hold the screen — this is the only moment it may appear.
  await expect(page.locator('.pp-loading h2')).toHaveText('Taking you to PayHere…');
  await expect(page.locator('.pp-loading .amt')).toHaveText('$498.85');
});

test('billing details are collected and sent — never the old N/A / Colombo placeholder', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  let sent = null;
  await page.route('**/quotes/pay/start', async (r) => {
    sent = JSON.parse(r.request().postData());
    await r.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ error: 'bad_request', message: 'stop here' }) });
  });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();

  // Billing is required: continuing without it names the empty box rather than failing silently.
  await page.locator('#gobtn').click();
  await expect(page.locator('#payerr')).toContainText('billing address');

  await page.locator('#f-addr').fill('Prinsengracht 263');
  await page.locator('#f-city').fill('Amsterdam');
  await page.locator('#f-postcode').fill('1016 GV'); // required since 2026-08-02
  await page.locator('#f-bcountry').selectOption('Netherlands');

  // The cardholder row is hidden until the payer says billing differs.
  await expect(page.locator('#billnames')).toBeHidden();
  await page.locator('#f-diffbill').check();
  await expect(page.locator('#billnames')).toBeVisible();
  await page.locator('#f-bfirst').fill('Anja');
  await page.locator('#f-blast').fill('de Vries');
  await page.locator('#f-terms').check();

  await page.locator('#gobtn').click();
  await expect.poll(() => sent?.billing?.city).toBe('Amsterdam');
  expect(sent.billing).toEqual({
    address: 'Prinsengracht 263', city: 'Amsterdam', postcode: '1016 GV', country: 'Netherlands',
    firstName: 'Anja', lastName: 'de Vries',
  });
  // The lead passenger is untouched — billing belongs to the transaction, not the traveller.
  expect(sent.customer.firstName).toBe('Nimal');
});

test('the cancellation policy shown matches the product, and terms gate the payment', async ({ page }) => {
  // The two ladders are genuinely different — a chauffeur trip is capped at 80% ten days out,
  // where a transfer is fully refundable until 24 hours before. Showing the wrong one at the
  // moment of payment would be worse than showing none.
  await stubView(page, { state: 'payable', copy: COPY.chauffeur, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await expect(page.locator('.dt-terms')).toContainText('Free cancellation until 10 days before');
  await expect(page.locator('.dt-pol')).toContainText('80% refund');
  await expect(page.locator('.dt-pol')).toContainText('40% refund');
  // The headline is visible without interaction; the ladder is one tap away, not a hover.
  await expect(page.locator('.dt-pol ul')).toBeHidden();
  await page.locator('.dt-pol summary').click();
  await expect(page.locator('.dt-pol ul')).toBeVisible();

  // Terms are required — continuing without them names the reason.
  await page.locator('#f-addr').fill('Prinsengracht 263');
  await page.locator('#f-city').fill('Amsterdam');
  await page.locator('#f-postcode').fill('1016 GV'); // optional since 2026-08-02, filled here anyway
  await page.locator('#f-bcountry').selectOption('Netherlands');
  await page.locator('#gobtn').click();
  await expect(page.locator('#payerr')).toContainText('terms');

  await page.unrouteAll();
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await expect(page.locator('.dt-terms')).toContainText('Free cancellation until 24 hours before');
  await expect(page.locator('.dt-pol')).not.toContainText('80%'); // never the chauffeur ladder
});

test('the CTA reads as unavailable until the terms are ticked — but still says why', async ({ page }) => {
  // Owner-caught 2026-08-02: "Continue to payment" looked live before the box was ticked, so the
  // only thing telling a payer consent was required was an error AFTER they committed.
  //
  // Dimmed only — NOT disabled, and not aria-disabled either (Playwright refuses to click an
  // aria-disabled button, which is exactly the point: ARIA would announce it as disabled). Both
  // make the button inert, and an inert CTA with nothing explaining it reads as a broken page on
  // the last screen before the money. Press it and it names the reason, like every other required
  // field here.
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();

  const cta = page.locator('#gobtn');
  await expect(cta).toHaveClass(/is-off/);
  await expect(cta).toBeEnabled(); // reachable by keyboard and by click, never inert

  // Clicking while it reads unavailable is not a no-op — it names the reason and puts the
  // payer ON the checkbox, one keystroke from fixing it. (Address first: it validates ahead of
  // the terms, so an empty form would answer with the address message instead.)
  await page.locator('#f-addr').fill('Prinsengracht 263');
  await page.locator('#f-city').fill('Amsterdam');
  await cta.click();
  await expect(page.locator('#payerr')).toContainText('terms');
  await expect(page.locator('#f-terms')).toBeFocused();

  await page.locator('#f-terms').check();
  await expect(cta).not.toHaveClass(/is-off/);

  // …and it goes back if they change their mind.
  await page.locator('#f-terms').uncheck();
  await expect(cta).toHaveClass(/is-off/);
});

test('the billing country follows the phone country code, until the payer picks one', async ({ page }) => {
  // Owner-caught 2026-08-02: the billing country was set ONCE from the phone prefill and never
  // moved, so switching the dial code to United States left billing reading Sri Lanka.
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await expect(page.locator('#f-country')).toHaveValue('Sri Lanka');
  await expect(page.locator('#f-bcountry')).toHaveValue('Sri Lanka');

  await page.locator('#f-country').selectOption('United States');
  await expect(page.locator('#f-bcountry')).toHaveValue('United States'); // followed

  // …but an explicit billing choice is never overwritten afterwards.
  await page.locator('#f-bcountry').selectOption('Netherlands');
  await page.locator('#f-country').selectOption('Sri Lanka');
  await expect(page.locator('#f-bcountry')).toHaveValue('Netherlands');
});

test('the postcode is required and travels with the billing details', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  let sent = null;
  await page.route('**/quotes/pay/start', async (r) => {
    sent = JSON.parse(r.request().postData());
    await r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_request', message: 'stop' }) });
  });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await page.locator('#f-addr').fill('31 River Court, Apt 105');
  await page.locator('#f-city').fill('Jersey City');
  await page.locator('#f-postcode').fill('07310');
  await page.locator('#f-terms').check();
  await page.locator('#gobtn').click();
  await expect.poll(() => sent?.billing?.postcode).toBe('07310');
});

// Optimising for AUTHORISATION RATE, not address completeness (owner, 2026-08-02). Hong Kong,
// the UAE and ~60 other countries have no postcode, so requiring one is a guaranteed
// non-payment for those customers — strictly worse than a blank field, because the payment
// never reaches PayHere at all. PayHere's own list of common declines (insufficient funds,
// 3DS/OTP failure, expired card, do not honor) does not mention address or AVS.
test('a payer with no postcode can still pay — the field never blocks', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  let sent = null;
  await page.route('**/quotes/pay/start', async (r) => {
    sent = JSON.parse(r.request().postData());
    await r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_request', message: 'stop' }) });
  });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await page.locator('#f-addr').fill('Flat 12, 8 Queen\'s Road Central');
  await page.locator('#f-city').fill('Hong Kong');
  await page.locator('#f-terms').check();
  await page.locator('#gobtn').click();                 // postcode left EMPTY, on purpose
  await expect.poll(() => sent?.billing?.city).toBe('Hong Kong');
  expect(sent.billing.postcode).toBeUndefined();
  await expect(page.locator('#payerr')).not.toContainText('postcode');
});

test('country is the FIRST billing field, since it gives the others meaning', async ({ page }) => {
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  const order = await page.locator('#f-bcountry, #f-addr, #f-city, #f-postcode')
    .evaluateAll((els) => els.map((e) => e.id));
  expect(order[0]).toBe('f-bcountry');
});

test('the payment page shows no cookie banner', async ({ page }) => {
  // Owner call (2026-08-01): a customer mid-payment is not the audience for a consent
  // prompt. The GTM consent DEFAULT is denied (set in <head>), so no banner ≠ tracking.
  await stubView(page, { state: 'payable', copy: COPY.single, totals: TOTALS, prefill: PREFILL });
  await page.goto(PAGE);
  await expect(page.locator('#paybtn')).toBeVisible(); // page fully rendered first
  await expect(page.locator('#ch-consent')).toHaveCount(0);
});
