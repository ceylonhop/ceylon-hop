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
  await stubView(page, { state: 'paid', paid: { reference: 'CH-4J2QP', firstName: 'Nimal', amountUsd: '$498.85', title: 'Six days across Sri Lanka' } });
  await page.goto(PAGE);
  await expect(page.locator('.st-title')).toContainText('You’re booked, Nimal');
  await expect(page.locator('.refchip')).toHaveText('CH-4J2QP');
  await expect(page.locator('#paybtn')).toHaveCount(0);
  await expect(page.locator('.next')).toContainText('What happens next');
});

test('revised and unavailable: soft states, no button, nothing charged', async ({ page }) => {
  await stubView(page, { state: 'revised' });
  await page.goto(PAGE);
  await expect(page.locator('.st-title')).toContainText('This quote has been updated');
  await expect(page.locator('#paybtn')).toHaveCount(0);

  await page.unrouteAll();
  await stubView(page, { state: 'unavailable' });
  await page.goto(PAGE);
  await expect(page.locator('.st-title')).toContainText('no longer active');
  await expect(page.locator('body')).toContainText('WhatsApp');
});
