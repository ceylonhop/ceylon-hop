import { test, expect } from '@playwright/test';

// pay.html and quote.html are opened from a bare `?t=` link token, and that token alone unlocks
// the quote — while it is payable, /quotes/pay/view hands back the customer's name, email and
// phone; once booked, /quote-view hands back a signed manage link. GTM's tags (GA4 page_location,
// Clarity, the Meta and TikTok pixels) all read the page URL, and the API stamps the same token
// into og:url / og:image for the WhatsApp unfurl. So the token has to be gone from both BEFORE the
// tag snippet runs, and the page must still work — first load and reload — without it in the URL.
//
// "Before the tags" is measured, not assumed: an init script traps the first assignment to
// window.dataLayer (the consent block's opening line, immediately ahead of the GTM loader) and
// records what a tag would have seen at that moment.

const TOKEN = 'test-token-SECRET';

const PAGES = [
  {
    name: 'pay.html',
    path: '/pay.html',
    api: '**/quotes/pay/view*',
    body: {
      state: 'payable',
      copy: {
        product: 'single', greetingName: 'Emma', title: 'Colombo Airport (CMB) → Galle',
        subtitle: 'Saturday 8 August 2026', facts: [], legs: null,
        includedText: 'Driver, fuel and highway tolls.', totalLabel: 'Total',
      },
      totals: { cents: 49885, usd: '$498.85', lkr: 'LKR 164,620' },
      prefill: { firstName: 'Emma', lastName: '', email: '', whatsapp: '', country: '' },
    },
    rendered: '.pp-title',
  },
  {
    name: 'quote.html',
    path: '/quote.html',
    api: '**/quote-view*',
    body: {
      state: 'live',
      validUntil: '2099-01-01T00:00:00.000Z',
      view: {
        reference: 'Q-E2E77', greetingName: 'Anna', title: 'Colombo Airport → Ella',
        subtitle: '1-day private trip · 2 travellers', heroTotalUsd: '$450', heroTotalNote: 'private',
        days: [{ kind: 'journey', date: 'MON 10 AUG', title: 'Colombo Airport → Ella', meta: null, stops: [] }],
        mapStops: [], totalKm: 200, travelDays: 1,
        options: [{
          service: 'private', name: 'Private transfers', blurb: 'b', included: { lead: 'l', items: ['A car'] },
          includedText: 'i', totalCents: 45000, totalUsd: '$450', deltaUsd: null, deltaText: null,
          cancellation: { headline: 'h', ladder: ['x'] }, lead: true, legPrices: null, waText: 'w',
        }],
        waText: 'q',
      },
    },
    rendered: '.pp-title',
  },
];

// What customerPages.ts injects right after <head> when the API serves these pages.
function ogTags(path) {
  const url = `https://pay.ceylonhop.com${path}?t=${TOKEN}`;
  return [
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="https://pay.ceylonhop.com/pay/card.png?t=${TOKEN}">`,
    `<meta property="twitter:image" content="https://pay.ceylonhop.com/pay/card.png?t=${TOKEN}">`,
  ].join('\n');
}

async function setUp(page, p) {
  const apiTokens = [];
  await page.route(p.api, (r) => {
    apiTokens.push(new URL(r.request().url()).searchParams.get('t'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(p.body) });
  });
  await page.route('**/errors/client', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.route('https://www.payhere.lk/**', (r) => r.abort());
  // Serve the page the way the API does: with the per-token share tags in its head.
  await page.route(`**${p.path}*`, async (r) => {
    if (r.request().resourceType() !== 'document') return r.fallback();
    const res = await r.fetch();
    const html = (await res.text()).replace('<head>', `<head>\n${ogTags(p.path)}`);
    return r.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html' } });
  });
  await page.addInitScript(() => {
    let dl;
    Object.defineProperty(window, 'dataLayer', {
      configurable: true,
      get() { return dl; },
      set(v) {
        if (window.__seenByTags === undefined) {
          window.__seenByTags = {
            href: location.href,
            meta: [...document.querySelectorAll('meta[property], meta[name]')].map((m) => m.content).join(' '),
          };
        }
        dl = v;
      },
    });
  });
  return apiTokens;
}

for (const p of PAGES) {
  test(`${p.name}: the link token is gone from the URL and share tags before any tag runs`, async ({ page }) => {
    const apiTokens = await setUp(page, p);
    await page.goto(`${p.path}?t=${TOKEN}`);
    await expect(page.locator(p.rendered)).toBeVisible();

    const seen = await page.evaluate(() => window.__seenByTags);
    expect(seen, 'the consent/GTM snippet never ran').toBeTruthy();
    expect(seen.href).not.toContain(TOKEN);
    expect(seen.meta).not.toContain(TOKEN);
    expect(page.url()).not.toContain(TOKEN);
    expect(await page.evaluate(() => document.head.innerHTML)).not.toContain(TOKEN);
    // …and the page still used it.
    expect(apiTokens).toContain(TOKEN);
  });

  test(`${p.name}: a reload still opens the same quote`, async ({ page }) => {
    const apiTokens = await setUp(page, p);
    await page.goto(`${p.path}?t=${TOKEN}`);
    await expect(page.locator(p.rendered)).toBeVisible();
    apiTokens.length = 0;

    await page.reload();
    await expect(page.locator(p.rendered)).toBeVisible();
    expect(apiTokens).toEqual([TOKEN]);
    expect(page.url()).not.toContain(TOKEN);
  });

  test(`${p.name}: with storage blocked the token stays in the URL, so the page still works`, async ({ page }) => {
    const apiTokens = await setUp(page, p);
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => { throw new Error('storage blocked'); };
    });
    await page.goto(`${p.path}?t=${TOKEN}`);
    await expect(page.locator(p.rendered)).toBeVisible();
    expect(apiTokens).toContain(TOKEN);
    expect(page.url()).toContain(TOKEN);
  });
}
