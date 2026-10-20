import { test, expect } from '@playwright/test';
import { TA_LOGO, TA_LOGO_SVG } from './_stubs.js';

// Partner experiences on the pay-link confirmation (owner, 2026-10-15). Moved here from quote.html
// ("a distraction" before the customer has paid), with the same rows and behaviour: they show on the
// `paid` keepsake and on the `balance` "You're booked" screen, BELOW the ticket / Pay balance and
// "What happens next". A "Request info" tap POSTs {t, experienceId, interested} to
// /quotes/pay/interest, which records a lead on the BOOKING — it never touches the balance.
// Offline: every /quotes/pay/*, /bookings/* and /experiences/* call is stubbed.

const PAGE = '/pay.html?t=test-token';

const xpItem = (o) => ({
  id: '11111111-1111-4111-8111-111111111111', slug: 'placeholder-ayurvedic-massage', name: 'Ayurvedic massage',
  partnerName: 'Atherya Spa', areaLabel: 'Sigiriya', summary: 'A 90-minute Ayurvedic massage with herbal oils.',
  details: 'Some details.', priceCents: 3500, currency: 'USD', priceUnit: 'per_person', durationText: '90 min',
  openWeekdays: [0, 1, 2, 3, 4, 5, 6], startTimes: ['09:00'], photos: [], aboutKm: 4, interested: false, ...o,
});
const XP_MASSAGE = xpItem({});
const XP_COOKING = xpItem({
  id: '22222222-2222-4222-8222-222222222222', slug: 'placeholder-village-cooking-lesson', name: 'Village cooking lesson',
  partnerName: 'Suwee', summary: 'Cook a Sri Lankan village meal.', priceCents: 2500, interested: true,
});
const XP_STOPS = [{ place: 'Sigiriya', items: [XP_MASSAGE, XP_COOKING] }];

const BALANCE = {
  title: 'Three days across Sri Lanka', totalUsd: '$299.00', paidUsd: '$50.00', paidOn: '2026-10-05',
  balanceCents: 24900, balanceUsd: '$249.00', reference: 'CH-5EXFW', firstName: 'Roshen',
  copy: {
    product: 'chauffeur', greetingName: 'Roshen', title: 'Three days across Sri Lanka', subtitle: '14–16 Nov · your own car & driver',
    facts: [{ k: 'Trip', v: 'Colombo Airport (CMB) → Sigiriya' }, { k: 'Days', v: '3 with your driver' }, { k: 'Travellers', v: '2 · Car' }, { k: 'Starts', v: 'Sat 14 Nov' }],
    legs: null, includedText: 'Vehicle & English-speaking driver for all 3 days.', totalLabel: 'Total · 3 days',
  },
};
const PAID = { reference: 'CH-ABC12', firstName: 'Nimal', amountUsd: '$299.00', title: 'Three days across Sri Lanka' };
const balanceBody = (experiences = XP_STOPS) => ({ state: 'balance', balance: BALANCE, ...(experiences ? { experiences } : {}) });
const paidBody = (experiences = XP_STOPS) => ({ state: 'paid', paid: PAID, ...(experiences ? { experiences } : {}) });

async function stubView(page, body) {
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://www.payhere.lk/lib/**', (r) => r.abort());
  await page.route('**/errors/client', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

// Records every POST body and answers with `status` (200 echoes the requested state).
async function stubInterest(page, status = 200) {
  const posts = [];
  await page.route('**/quotes/pay/interest', async (r) => {
    const req = r.request();
    const sent = JSON.parse(req.postData() || '{}');
    posts.push({ method: req.method(), body: sent });
    if (status !== 200) return r.fulfill({ status, contentType: 'application/json', body: '{"error":"boom"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interested: sent.interested }) });
  });
  return posts;
}

test.describe('partner experiences on the pay-link confirmation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://ceylonhop.com/img/**', (r) => r.abort());
  });

  test('balance screen: the block sits below the totals, Pay balance and "What happens next", with the owner-approved copy', async ({ page }) => {
    await stubView(page, balanceBody());
    await page.goto(PAGE);

    const block = page.locator('#experiences-block');
    await expect(block).toBeVisible();
    await expect(page.locator('#paybtn')).toHaveText('Pay balance');
    // Header copy appears exactly once (owner, 2026-10-07), the heading names the place.
    await expect(block.locator('.xp-kicker')).toHaveCount(1);
    await expect(block.locator('.xp-kicker')).toHaveText('Hand-picked by the Ceylon Hop concierge');
    await expect(block.locator('h3')).toHaveText('While you’re in Sigiriya');
    await expect(block.locator('.xp-sub')).toHaveCount(1);
    await expect(block.locator('.xp-sub')).toHaveText(
      'Request info on any of Ceylon Hop’s curated, recommended experiences — our concierge messages you with the details. No charge to request info.',
    );
    // No "free" (owner, 2026-10-15, #985): it made the experiences sound free; only the request costs nothing.
    expect(await block.innerText()).not.toMatch(/\bfree\b/i);
    await expect(block.locator('.xp-row')).toHaveCount(2);
    const row = block.locator('.xp-row').first();
    await expect(row.locator('.xp-name')).toHaveText('Ayurvedic massage');
    await expect(row.locator('.xp-meta')).toHaveText('Atherya Spa · 4 km · 90 min · Daily');
    // No price on the customer card (owner, 2026-10-14).
    await expect(block.locator('.xp-price')).toHaveCount(0);
    await expect(block).not.toContainText('$35');
    await expect(row.locator('.xp-btn')).toHaveText('Request info');
    await expect(row.locator('.xp-buy .xp-free')).toHaveText('No charge for requesting info');
    await expect(block.locator('.xp-free')).toHaveCount(2);
    await expect(row.locator('.xp-more')).toContainText('Details');
    await expect(block.locator('.xp-ta')).toHaveCount(0);
    for (const t of await block.locator('.xp-btn').allTextContents()) expect(t).not.toMatch(/free|no charge/i);

    // DOM order: the totals and Pay balance, then "What happens next", then the experiences, then the WhatsApp line.
    const order = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('#app *'));
      const pos = (sel) => all.indexOf(document.querySelector(sel));
      return { total: pos('.t-stub .tot-final'), pay: pos('#paybtn'), next: pos('.next'), xp: pos('#experiences-block'), note: pos('.pp-note') };
    });
    expect(order.total).toBeGreaterThan(-1);
    expect(order.pay).toBeGreaterThan(order.total);
    expect(order.next).toBeGreaterThan(order.pay);
    expect(order.xp).toBeGreaterThan(order.next);
    expect(order.note).toBeGreaterThan(order.xp);
    // And on screen: the Pay balance button is above the whole block.
    const payBottom = await page.locator('#paybtn').evaluate((el) => el.getBoundingClientRect().bottom);
    const blockTop = await block.evaluate((el) => el.getBoundingClientRect().top);
    expect(payBottom).toBeLessThan(blockTop);
  });

  test('paid keepsake: the block sits below the pass and "What happens next"', async ({ page }) => {
    await stubView(page, paidBody());
    await page.goto(PAGE);
    await expect(page.locator('.st-title')).toHaveText('You’re booked, Nimal.');
    const block = page.locator('#experiences-block');
    await expect(block).toBeVisible();
    await expect(block.locator('.xp-row')).toHaveCount(2);
    await expect(block.locator('.xp-row').first().locator('.xp-btn')).toHaveText('Request info');
    const order = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('#app *'));
      const pos = (sel) => all.indexOf(document.querySelector(sel));
      return { pass: pos('.pass'), next: pos('.next'), xp: pos('#experiences-block'), note: pos('.pp-note') };
    });
    expect(order.pass).toBeGreaterThan(-1);
    expect(order.next).toBeGreaterThan(order.pass);
    expect(order.xp).toBeGreaterThan(order.next);
    expect(order.note).toBeGreaterThan(order.xp);
  });

  test('back from PayHere: the paid keepsake it lands on carries the block too', async ({ page }) => {
    await page.addInitScript(() => {
      try { sessionStorage.setItem('ch_pay_v1', JSON.stringify({ t: 'test-token', typed: null, cents: 29900, item: null })); } catch (e) { /* none */ }
    });
    await stubView(page, paidBody());
    await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'paid', reference: 'CH-ABC12', sandbox: false }) }));
    const posts = await stubInterest(page);
    await page.goto('/pay.html?rt=any-token');
    await expect(page.locator('.st-title')).toContainText('You’re booked');
    const btn = page.locator('#experiences-block .xp-row').first().locator('.xp-btn');
    await btn.click();
    await expect(btn).toHaveText('✓ Info requested');
    expect(posts).toEqual([{ method: 'POST', body: { t: 'test-token', experienceId: XP_MASSAGE.id, interested: true } }]);
  });

  test('later stops repeat only the "While you’re in" heading', async ({ page }) => {
    const second = xpItem({ id: '33333333-3333-4333-8333-333333333333', slug: 'placeholder-tea', name: 'Tea tasting', partnerName: 'Hills' });
    await stubView(page, balanceBody([...XP_STOPS, { place: 'Ella', items: [second] }]));
    await page.goto(PAGE);
    const block = page.locator('#experiences-block');
    await expect(block.locator('h3')).toHaveText(['While you’re in Sigiriya', 'While you’re in Ella']);
    await expect(block.locator('.xp-kicker')).toHaveCount(1);
    await expect(block.locator('.xp-sub')).toHaveCount(1);
  });

  test('initial state comes from item.interested', async ({ page }) => {
    await stubView(page, balanceBody());
    await page.goto(PAGE);
    const rows = page.locator('#experiences-block .xp-row');
    await expect(rows.nth(0).locator('.xp-btn')).toHaveAttribute('aria-pressed', 'false');
    await expect(rows.nth(0).locator('.xp-btn')).toHaveText('Request info');
    await expect(rows.nth(1).locator('.xp-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1).locator('.xp-btn')).toHaveText('✓ Info requested');
    await expect(rows.nth(1)).toHaveClass(/\bon\b/);
  });

  test('a tap POSTs {t, experienceId, interested:true} and flips the row; a second tap withdraws', async ({ page }) => {
    await stubView(page, balanceBody());
    const posts = await stubInterest(page);
    await page.goto(PAGE);

    const row = page.locator('#experiences-block .xp-row').first();
    const btn = row.locator('.xp-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveText('✓ Info requested');
    expect(posts).toEqual([{ method: 'POST', body: { t: 'test-token', experienceId: XP_MASSAGE.id, interested: true } }]);

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveText('Request info');
    expect(posts[1].body).toEqual({ t: 'test-token', experienceId: XP_MASSAGE.id, interested: false });
  });

  test('a selected row stays white (accent bar, not a tint)', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubInterest(page);
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').first();
    await row.locator('.xp-btn').click();
    await expect(row).toHaveClass(/\bon\b/);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250); // let the 150ms transition settle
    const css = await row.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, shadow: s.boxShadow };
    });
    expect(css.bg).toBe('rgb(255, 255, 255)');
    expect(css.shadow).not.toBe('none');
  });

  test('the balance and the Pay balance button never change when a row is tapped', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubInterest(page);
    await page.goto(PAGE);
    const due = page.locator('.t-stub .tot-final .v');
    await expect(due).toHaveText('$249.00');
    await page.locator('#experiences-block .xp-btn').first().click();
    await expect(page.locator('#experiences-block .xp-btn').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(due).toHaveText('$249.00');
    await expect(page.locator('#paybtn')).toHaveText('Pay balance');
    await expect(page.locator('#paybtn')).toBeEnabled();
  });

  test('a refused balance checkout re-renders the screen with the requested state kept', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubInterest(page);
    await page.route('**/quotes/pay/balance', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bookingId: 'b-1', checkoutToken: 'ct-1' }) }));
    await page.route('**/bookings/b-1/checkout', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto(PAGE);
    await page.locator('#experiences-block .xp-row').first().locator('.xp-btn').click();
    await expect(page.locator('#experiences-block .xp-row').first().locator('.xp-btn')).toHaveText('✓ Info requested');
    await page.locator('#paybtn').click();
    await expect(page.locator('#payerr')).toBeVisible();
    await expect(page.locator('#experiences-block .xp-row').first().locator('.xp-btn')).toHaveText('✓ Info requested');
  });

  test('a failed save reverts the row and says so; the next tap retries', async ({ page }) => {
    await stubView(page, balanceBody());
    const posts = await stubInterest(page, 500);
    await page.goto(PAGE);

    const row = page.locator('#experiences-block .xp-row').first();
    const btn = row.locator('.xp-btn');
    await btn.click();
    await expect(row.locator('.xp-err')).toHaveText('Couldn’t save — try again');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveText('Request info');
    expect(posts).toHaveLength(1);

    await page.unroute('**/quotes/pay/interest');
    await stubInterest(page);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('.xp-err')).toBeHidden();
  });

  test('a failed withdraw restores the requested state', async ({ page }) => {
    await stubView(page, paidBody());
    await stubInterest(page, 500);
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').nth(1);
    await row.locator('.xp-btn').click();
    await expect(row.locator('.xp-err')).toBeVisible();
    await expect(row.locator('.xp-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('.xp-btn')).toHaveText('✓ Info requested');
  });

  test('the server’s answer wins: a withdraw that comes back {interested:true} stays ticked', async ({ page }) => {
    await stubView(page, paidBody());
    await page.route('**/quotes/pay/interest', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"interested":true}' }));
    await page.goto(PAGE);
    const btn = page.locator('#experiences-block .xp-row').nth(1).locator('.xp-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  test('experiences: [] renders nothing, and so does a missing key; the payable page never shows them', async ({ page }) => {
    await stubView(page, balanceBody([]));
    await page.goto(PAGE);
    await expect(page.locator('#paybtn')).toHaveText('Pay balance');
    await expect(page.locator('#experiences-block')).toHaveCount(0);

    await page.unroute('**/quotes/pay/view*');
    await stubView(page, paidBody(null));
    await page.reload();
    await expect(page.locator('.st-title')).toContainText('You’re booked');
    await expect(page.locator('#experiences-block')).toHaveCount(0);

    // Before payment the server sends none; even if it did, the payable page draws none.
    await page.unroute('**/quotes/pay/view*');
    await stubView(page, {
      state: 'payable', experiences: XP_STOPS,
      copy: { product: 'single', title: 'Colombo Airport (CMB) → Galle', subtitle: 'Saturday 8 August 2026', facts: [{ k: 'Travellers', v: '2' }], legs: null, includedText: 'All in.', totalLabel: 'Total' },
      totals: { cents: 21900, usd: '$219.00' }, prefill: { firstName: 'Nimal', lastName: '', email: '', whatsapp: '', country: '' },
    });
    await page.reload();
    await expect(page.locator('#paybtn')).toBeVisible();
    await expect(page.locator('#experiences-block')).toHaveCount(0);
  });

  test('"Details ›" opens an inline panel', async ({ page }) => {
    await stubView(page, balanceBody());
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').first();
    await expect(row.locator('.xp-panel')).toBeHidden();
    await row.locator('.xp-more').click();
    await expect(row.locator('.xp-panel')).toBeVisible();
    await expect(row.locator('.xp-panel')).toContainText('Some details.');
    await expect(row.locator('.xp-panel')).toContainText('Open: Daily');
    await expect(row.locator('.xp-panel')).toContainText('Times: 09:00');
    await expect(row.locator('.xp-more')).toHaveAttribute('aria-expanded', 'true');
    await row.locator('.xp-more').click();
    await expect(row.locator('.xp-panel')).toBeHidden();
  });

  test('a hostile name is rendered as text, not markup', async ({ page }) => {
    const evil = xpItem({ name: `<img src=x onerror="window.__pwned=1">'"&`, partnerName: `Bob's <b>spa</b>`, id: `11111111-1111-4111-8111-111111111111" onclick="window.__pwned=2` });
    await stubView(page, balanceBody([{ place: 'Sigiriya', items: [evil] }]));
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block .xp-name')).toHaveText(evil.name);
    await expect(page.locator('#experiences-block .xp-meta')).toContainText(evil.partnerName);
    await page.locator('#experiences-block .xp-row').click({ position: { x: 5, y: 5 } });
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.locator('#experiences-block .xp-row').evaluate((el) => el.getAttribute('data-id'))).toBe(evil.id);
  });

  test('at 375px nothing overflows sideways and names are not ellipsis-truncated', async ({ page }) => {
    const long = xpItem({ name: 'Sunrise guided hike with a traditional village breakfast and tea', partnerName: 'A very long partner name Ltd' });
    await page.setViewportSize({ width: 375, height: 800 });
    await stubView(page, balanceBody([{ place: 'Sigiriya', items: [long, XP_COOKING] }]));
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block .xp-row')).toHaveCount(2);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const names = Array.from(document.querySelectorAll('#experiences-block .xp-name'));
      return {
        overflowX: de.scrollWidth - de.clientWidth,
        truncated: names.filter((n) => n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1).length,
        wrapped: names.every((n) => getComputedStyle(n).whiteSpace === 'normal'),
      };
    });
    expect(m.overflowX).toBeLessThanOrEqual(0);
    expect(m.truncated).toBe(0);
    expect(m.wrapped).toBe(true);
  });

  test('a tap is reported to analytics as source pay_page', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubInterest(page);
    await page.goto(PAGE);
    await page.locator('#experiences-block .xp-btn').first().click();
    await page.waitForFunction(() => (window.dataLayer || []).some((e) => e.event === 'experience_interest'));
    const hit = await page.evaluate(() => window.dataLayer.find((e) => e.event === 'experience_interest'));
    expect(hit).toMatchObject({ experience_slug: 'placeholder-ayurvedic-massage', place: 'Sigiriya', source: 'pay_page', interested: true });
  });
});

// ── Live Tripadvisor ratings on the confirmation (spec 2026-10-06 D22) — moved with the rows ──────
// One GET /experiences/ratings after the rows paint; the rating is the Tripadvisor bubble image +
// "N reviews" linked to the listing. Absent or failed = nothing, and the rows are never held up.
const TA_IMG = 'https://www.tripadvisor.com/img/cdsi/img2/ratings/traveler/4.5-12345-5.svg';
const TA_URL = 'https://www.tripadvisor.com/Attraction_Review-g1-d6789012-Reviews-Spa.html';
const taRating = (o) => ({ id: XP_MASSAGE.id, rating: 4.5, numReviews: 312, ratingImageUrl: TA_IMG, webUrl: TA_URL, ...o });
async function stubRatings(page, answer) {
  const asked = [];
  await page.route('**/experiences/ratings*', async (r) => {
    asked.push((new URL(r.request().url()).searchParams.get('ids') || '').split(','));
    if (answer.delayMs) await new Promise((res) => setTimeout(res, answer.delayMs));
    if (answer.status && answer.status !== 200) return r.fulfill({ status: answer.status, contentType: 'application/json', body: '{"error":"boom"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...((answer.ratings || []).length ? { logoUrl: answer.logoUrl === undefined ? TA_LOGO : answer.logoUrl } : {}), ratings: answer.ratings || [] }) });
  });
  await page.route(TA_LOGO, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: TA_LOGO_SVG }));
  await page.route('https://www.tripadvisor.com/img/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="75" height="15"/>' }));
  return asked;
}

test.describe('Tripadvisor ratings on the pay-link confirmation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://ceylonhop.com/img/**', (r) => r.abort());
  });

  test('a rating appears under the meta line: the bubble image, "312 reviews", linked to the listing in a new tab', async ({ page }) => {
    await stubView(page, balanceBody());
    const asked = await stubRatings(page, { ratings: [taRating()] });
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').first();
    const link = row.locator('a.xp-ta');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', TA_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toContainText('312 reviews');
    await expect(link.locator('img.xp-ta-bubbles')).toHaveAttribute('src', TA_IMG);
    await expect(link.locator('img.xp-ta-bubbles')).toHaveAttribute('alt', 'Tripadvisor rating 4.5 of 5');
    const order = await row.evaluate((r) => {
      const y = (sel) => r.querySelector(sel).getBoundingClientRect().top;
      return [y('.xp-meta'), y('.xp-ta'), y('.xp-more')];
    });
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual([XP_MASSAGE.id, XP_COOKING.id]);
    await expect(page.locator('#experiences-block a.xp-ta')).toHaveCount(1);
  });

  test('the paid keepsake asks for ratings too', async ({ page }) => {
    await stubView(page, paidBody());
    const asked = await stubRatings(page, { ratings: [taRating()] });
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block a.xp-ta')).toHaveCount(1);
    expect(asked).toHaveLength(1);
  });

  test('the Tripadvisor logo sits left of the bubbles, at least 20px tall; the bubbles are at least 55px wide; one link', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubRatings(page, { ratings: [taRating()] });
    await page.goto(PAGE);
    const link = page.locator('#experiences-block a.xp-ta');
    await expect(link).toHaveCount(1);
    const logo = link.locator('img.xp-ta-logo');
    await expect(logo).toHaveCount(1);
    await expect(logo).toHaveAttribute('src', TA_LOGO);
    await expect(logo).toHaveAttribute('alt', 'Tripadvisor');
    await expect(link.locator('img')).toHaveCount(2);
    await expect.poll(() => logo.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
    const m = await link.evaluate((a) => {
      const l = a.querySelector('img.xp-ta-logo').getBoundingClientRect();
      const b = [...a.querySelectorAll('img')].find((i) => !i.classList.contains('xp-ta-logo')).getBoundingClientRect();
      const span = a.querySelector('span').getBoundingClientRect();
      return { logo: { right: l.right, top: l.top, bottom: l.bottom, h: l.height }, bubbles: { left: b.left, w: b.width, top: b.top, bottom: b.bottom }, span: { left: span.left } };
    });
    expect(m.logo.h).toBeGreaterThanOrEqual(20);
    expect(m.logo.right).toBeLessThanOrEqual(m.bubbles.left + 0.5);
    expect(m.bubbles.left).toBeLessThanOrEqual(m.span.left);
    expect(m.logo.top).toBeLessThan(m.bubbles.bottom);
    expect(m.bubbles.top).toBeLessThan(m.logo.bottom);
    expect(m.bubbles.w).toBeGreaterThanOrEqual(55);
    const bg = await link.evaluate((a) => { for (let e = a; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)') return c; } return 'none'; });
    expect(bg).toBe('rgb(255, 255, 255)');
  });

  test('no logo in the answer (or one that is not https) means no rating is shown at all', async ({ page }) => {
    for (const logoUrl of [null, 'http://static.tacdn.com/x.svg', 'javascript:window.__xss=1']) {
      await stubView(page, balanceBody());
      await stubRatings(page, { ratings: [taRating()], logoUrl });
      await page.goto(PAGE);
      await expect(page.locator('#experiences-block .xp-row')).toHaveCount(2);
      await page.waitForTimeout(400);
      await expect(page.locator('#experiences-block .xp-ta')).toHaveCount(0);
      await page.unroute('**/experiences/ratings*');
    }
  });

  test('at 375px the rating link is a 32px tap target and nothing overflows', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await stubView(page, balanceBody());
    await stubRatings(page, { ratings: [taRating()] });
    await page.goto(PAGE);
    const link = page.locator('#experiences-block a.xp-ta');
    await expect(link).toHaveCount(1);
    const m = await link.evaluate((a) => {
      const r = a.getBoundingClientRect(), row = a.closest('.xp-row').getBoundingClientRect();
      return { h: r.height, right: r.right, rowRight: row.right, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(m.h).toBeGreaterThanOrEqual(32);
    expect(m.h, 'logo + bubbles + count stay on one line at 375px').toBeLessThan(40);
    expect(m.right).toBeLessThanOrEqual(m.rowRight);
    expect(m.overflow).toBeLessThanOrEqual(0);
  });

  test('tapping Request still works with a rating on the row, and the rating stays', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubInterest(page);
    await stubRatings(page, { ratings: [taRating()] });
    await page.goto(PAGE);
    const row = page.locator('#experiences-block .xp-row').first();
    await expect(row.locator('a.xp-ta')).toHaveCount(1);
    await row.locator('.xp-btn').click();
    await expect(row.locator('.xp-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('a.xp-ta')).toHaveCount(1);
  });

  test('a failed ratings call leaves the rows exactly as they were', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubRatings(page, { status: 500 });
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block .xp-row')).toHaveCount(2);
    await page.waitForTimeout(400);
    await expect(page.locator('#experiences-block .xp-ta')).toHaveCount(0);
    await expect(page.locator('#experiences-block')).not.toContainText(/tripadvisor|reviews/i);
  });

  test('a ratings answer slower than 3 seconds is dropped; the rows stay', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubRatings(page, { ratings: [taRating()], delayMs: 3600 });
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block .xp-row')).toHaveCount(2);
    await page.waitForTimeout(4200);
    await expect(page.locator('#experiences-block .xp-ta')).toHaveCount(0);
  });

  test('a hostile answer never becomes a link: javascript: link, foreign image, bad numbers', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubRatings(page, { ratings: [
      taRating({ webUrl: 'javascript:window.__xss=1' }),
      taRating({ id: XP_COOKING.id, numReviews: 'lots' }),
    ] });
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block .xp-row')).toHaveCount(2);
    await page.waitForTimeout(400);
    await expect(page.locator('#experiences-block .xp-ta')).toHaveCount(0);
    expect(await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') || '')))).toBe(false);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('quotes and angle brackets in the answer stay text (attributes are double-quoted)', async ({ page }) => {
    await stubView(page, balanceBody());
    await stubRatings(page, { ratings: [taRating({ webUrl: 'https://www.tripadvisor.com/x?a="onmouseover="window.__xss=1&b=\'<i>' })] });
    await page.goto(PAGE);
    const link = page.locator('#experiences-block a.xp-ta');
    await expect(link).toHaveCount(1);
    expect(await link.evaluate((a) => a.getAttributeNames().sort())).toEqual(['class', 'href', 'rel', 'target']);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('no experiences, no ratings call', async ({ page }) => {
    await stubView(page, balanceBody([]));
    const asked = await stubRatings(page, { ratings: [taRating()] });
    await page.goto(PAGE);
    await expect(page.locator('#paybtn')).toBeVisible();
    await page.waitForTimeout(300);
    expect(asked).toHaveLength(0);
  });

  test('at 375px the Request info button is a 44px target and "Details ›" a 32px one', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await stubView(page, balanceBody());
    await stubRatings(page, { ratings: [taRating()] });
    await page.goto(PAGE);
    await expect(page.locator('#experiences-block a.xp-ta')).toHaveCount(1);
    const m = await page.evaluate(() => {
      const r = document.querySelector('#experiences-block .xp-row');
      return {
        btnH: r.querySelector('.xp-btn').getBoundingClientRect().height,
        moreH: r.querySelector('.xp-more').getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(m.btnH).toBeGreaterThanOrEqual(44);
    expect(m.moreH).toBeGreaterThanOrEqual(32);
    expect(m.overflow).toBeLessThanOrEqual(0);
  });
});
