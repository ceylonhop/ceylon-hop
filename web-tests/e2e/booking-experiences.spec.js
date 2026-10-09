import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, pickPlace, TA_LOGO, TA_LOGO_SVG } from './_stubs.js';
import { futureIsoDate } from '../dates.js';

// Partner experiences on booking.html step 3 (spec 2026-10-06 D9/D10/D16/D17). The page asks
// GET /experiences/near for what is close to the drop-off, shows compact rows (owner-approved
// Option B, 2026-10-07), and a "Request" tap only records an id: it never touches the price, and
// never blocks the booking. Live Tripadvisor ratings (spec D22) fill in under the meta line after the rows render.

const photo = (stem) => ({
  small: `https://ceylonhop.com/img/${stem}-900.jpg`,
  large: `https://ceylonhop.com/img/${stem}-1800.jpg`,
});
const exp = (o) => ({
  id: '11111111-1111-4111-8111-111111111111', slug: 'x', name: 'X', partnerName: 'P', areaLabel: 'Sigiriya',
  summary: 'Summary', details: 'Some details.', priceCents: 3500, currency: 'USD', priceUnit: 'per_person',
  durationText: '90 min', openWeekdays: [0, 1, 2, 3, 4, 5, 6], startTimes: ['09:00'], photos: [], aboutKm: 4, ...o,
});
// The three staging placeholders, in the public shape (toPublicExperience + aboutKm).
const MASSAGE = exp({
  id: '11111111-1111-4111-8111-111111111111', slug: 'placeholder-ayurvedic-massage', name: 'Ayurvedic massage',
  partnerName: 'Atherya Spa', summary: 'A 90-minute Ayurvedic massage with herbal oils.', priceCents: 3500,
  durationText: '90 min', startTimes: ['09:00', '11:00', '14:00', '16:00'], photos: [photo('guides/sigiriya/ayurveda')], aboutKm: 4,
});
const COOKING = exp({
  id: '22222222-2222-4222-8222-222222222222', slug: 'placeholder-village-cooking-lesson', name: 'Village cooking lesson',
  partnerName: 'Suwee', summary: 'Cook a Sri Lankan village meal with a local family.', priceCents: 2500,
  durationText: '3 hrs', openWeekdays: [1, 2, 3, 4, 5, 6], startTimes: ['10:00', '16:00'],
  photos: [photo('guides/sigiriya/family-food'), photo('guides/sigiriya/village')], aboutKm: 6,
});
const SAFARI = exp({
  id: '33333333-3333-4333-8333-333333333333', slug: 'placeholder-elephant-jeep-safari', name: 'Elephant jeep safari',
  partnerName: 'Sample jeep partner', summary: 'A jeep safari to see wild elephants.', priceCents: 4500, priceUnit: 'per_group',
  durationText: '3-4 hrs', startTimes: ['14:00'], photos: [photo('guides/sigiriya/elephants')], aboutKm: 9,
});
const SIGIRIYA = { place: 'Sigiriya', items: [MASSAGE, COOKING, SAFARI] };

const PRIVATE = 'mode=private&from=cmb-airport&to=sigiriya&price=121&vehicle=car';
const NEAR = futureIsoDate(30);
const TRIP = `mode=trip&stops=Sigiriya%7CKandy&nights=1,0&dates=${NEAR},${NEAR}&kms=100,100&pax=2&vehicle=car&start=${NEAR}`;

const block = (page) => page.locator('#experiences-block');
const goStep3 = (page) => page.evaluate(() => window.goStep(3));

test.beforeEach(async ({ page }) => {
  // The CDN photos are not part of the offline suite; a missing photo hides itself (onerror).
  await page.route('https://ceylonhop.com/img/**', (r) => r.abort());
});

test.describe('the experiences block on step 3', () => {
  test('a private transfer to Sigiriya shows the concierge header and the three rows', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);

    await expect(block(page)).toBeVisible();
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    await expect(block(page).locator('.xp-row')).toHaveCount(3);
    expect(nearRequests).toEqual([['Sigiriya@7.95,80.76']]);

    // The accent line, then the heading, then ONE explanation line (replaces the green box).
    await expect(block(page).locator('.xp-kicker')).toHaveText('Hand-picked by the Ceylon Hop concierge');
    await expect(block(page).locator('.xp-note')).toHaveCount(0);
    await expect(block(page).locator('.xp-sub')).toHaveCount(1);
    await expect(block(page).locator('.xp-sub')).toHaveText(
      'Request any of these free. Our concierge messages you to arrange it — you only pay if you go ahead.',
    );
    // The owner: don't repeat yourself - no per-row "won’t be charged" note, and "free" appears once.
    await expect(block(page).locator('.xp-after')).toHaveCount(0);
    const all = await block(page).innerText();
    expect(all).not.toMatch(/won’t be charged/i);
    expect(all.match(/\bfree\b/gi)).toHaveLength(1);
    // No ratings yet.
    expect(all).not.toMatch(/tripadvisor/i);
    await expect(block(page).locator('.xp-rate')).toHaveCount(0);

    const row = block(page).locator('.xp-row').first();
    await expect(row.locator('.xp-name')).toHaveText('Ayurvedic massage');
    await expect(row.locator('.xp-meta')).toHaveText('Atherya Spa · 4 km · 90 min · Daily');
    await expect(row.locator('.xp-price')).toHaveText('$35 pp');
    await expect(row.locator('.xp-btn')).toHaveText('Request');
    await expect(block(page).locator('.xp-row').nth(1).locator('.xp-meta')).toContainText('Mon–Sat');
    await expect(block(page).locator('.xp-row').nth(2).locator('.xp-price')).toHaveText('$45 per group');
    await expect(row.locator('.xp-photo')).toHaveCount(1);
  });

  test('"Details ›" is a text link that opens an inline panel with the times, the days and every photo', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const card = block(page).locator('.xp-row').nth(1);
    const more = card.locator('.xp-more');
    await expect(more).toHaveText('Details ›');
    await expect(more).toHaveAttribute('aria-controls', /^xp-panel-/);
    // A plain text link, not a boxed control.
    expect(await more.evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderTopWidth]; })).toEqual(['rgba(0, 0, 0, 0)', '0px']);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(card.locator('.xp-panel')).toBeHidden();

    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.xp-panel')).toBeVisible();
    await expect(card.locator('.xp-panel')).toContainText('Open: Mon–Sat');
    await expect(card.locator('.xp-panel')).toContainText('Times: 10:00 · 16:00');
    await expect(card.locator('.xp-panel')).toContainText('Some details.');
    await expect(card.locator('.xp-panel img')).toHaveCount(2);
    await expect(card.locator('.xp-panel img').first()).toHaveAttribute('srcset', /900\.jpg 900w, .*1800\.jpg 1800w/);

    await more.click();
    await expect(card.locator('.xp-panel')).toBeHidden();
  });

  test('tapping "Request" flips the button, marks the row, fills the summary line, and never moves the Total', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const total = page.locator('#sum-total');
    const before = await total.textContent();
    expect(before).toMatch(/\$/);

    const row = block(page).locator('.xp-row').first();
    const btn = row.locator('.xp-btn');
    await expect(btn).toHaveText('Request');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sum-experiences')).toBeHidden();

    await btn.click();
    await expect(btn).toHaveText('✓ Requested');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toHaveClass(/\bon\b/);
    await expect(block(page).locator('.xp-after')).toHaveCount(0);

    // The selected row stays white (the old tint let the cream page show through) and carries a
    // 3px accent bar on the left.
    expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    // (the bar eases in over .15s, so poll rather than sample mid-transition)
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/inset/);
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/\b3px\b/);

    const sum = page.locator('#sum-experiences');
    await expect(sum).toBeVisible();
    await expect(sum).toContainText('Experiences');
    await expect(sum).toContainText('1 requested · no charge');
    await expect(sum).toContainText('Ayurvedic massage');
    // A plain summary row, not a coloured callout: no fill of its own (it shows the summary card).
    expect(await sum.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await expect(total).toHaveText(before);

    // A second row: the count and the " · "-separated names follow.
    await block(page).locator('.xp-row').nth(2).locator('.xp-btn').click();
    await expect(sum).toContainText('2 requested · no charge');
    await expect(page.locator('#sum-experiences-list')).toHaveText('Ayurvedic massage · Elephant jeep safari');
    await expect(total).toHaveText(before);

    // A tap takes it back.
    await btn.click();
    await expect(btn).toHaveText('Request');
    await expect(row).not.toHaveClass(/\bon\b/);
    await expect(sum).toContainText('1 requested · no charge');
    await block(page).locator('.xp-row').nth(2).locator('.xp-btn').click();
    await expect(sum).toBeHidden();
    await expect(total).toHaveText(before);
  });

  test('no button on the block says "free" or "no charge", tapped or not', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const texts = async () => block(page).locator('button').allTextContents();
    for (const t of await texts()) expect(t).not.toMatch(/free|no charge/i);
    await block(page).locator('.xp-btn').first().click();
    for (const t of await texts()) expect(t).not.toMatch(/free|no charge/i);
  });
});

test.describe('the booking payload', () => {
  test('a single transfer sends experienceIds — ids only, no names or labels', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await block(page).locator('.xp-btn').nth(0).click();
    await block(page).locator('.xp-btn').nth(2).click();
    await fillContact(page);
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    const raw = (await reqP).postData();
    const body = JSON.parse(raw);

    expect(body.experienceIds).toEqual([MASSAGE.id, SAFARI.id]);
    for (const label of ['Ayurvedic', 'Atherya', 'Sigiriya@', 'placeholder-', 'jeep']) expect(raw).not.toContain(label);
    expect(Object.keys(body).filter((k) => /experience/i.test(k))).toEqual(['experienceIds']);
  });

  test('un-tapping everything leaves experienceIds out', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    const btn = block(page).locator('.xp-btn').first();
    await btn.click();
    await btn.click();
    await fillContact(page);
    const reqP = page.waitForRequest('**/bookings/single');
    await page.click('#pay-btn');
    expect('experienceIds' in JSON.parse((await reqP).postData())).toBe(false);
  });

  test('a trip sends experienceIds on /bookings/trip', async ({ page }) => {
    await gotoBooking(page, { query: TRIP, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await block(page).locator('.xp-btn').nth(1).click();
    await fillContact(page);
    const reqP = page.waitForRequest('**/bookings/trip');
    await page.click('#pay-btn');
    expect(JSON.parse((await reqP).postData()).experienceIds).toEqual([COOKING.id]);
  });
});

test.describe('where the points come from', () => {
  test('a trip asks once for every overnight stop, by name', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: TRIP, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    expect(nearRequests).toHaveLength(1);
    expect(nearRequests[0]).toHaveLength(2);
    expect(nearRequests[0][0]).toMatch(/^Sigiriya@7\.95,80\.76$/);
    expect(nearRequests[0][1]).toMatch(/^Kandy@7\.29,80\.63$/);
  });

  test('a shared seat asks about the catalogue drop-off', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, {
      query: 'mode=shared&from=cmb-airport&to=sigiriya&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1',
      experiences: { stops: [SIGIRIYA] },
    });
    await goStep3(page);
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    expect(nearRequests).toEqual([['Sigiriya@7.95,80.76']]);
  });

  test('leaving and re-entering step 3 does not ask again for the same stops', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(3);
    await page.evaluate(() => { window.goStep(2); window.goStep(3); });
    await page.locator('#ad-n').waitFor();
    expect(nearRequests).toHaveLength(1);
  });

  test('a drop-off picked from Google asks about that exact point, under the area’s name', async ({ page }) => {
    const { nearRequests } = await gotoBooking(page, { query: PRIVATE, pickGeo: { lat: 7.96, lng: 80.77 }, experiences: { stops: [SIGIRIYA] } });
    await pickPlace(page, '#loc-to', 'ac-to', 'Heritage', 0);
    await goStep3(page);
    await expect(block(page).locator('h3')).toHaveText('While you’re in Sigiriya');
    expect(nearRequests.at(-1)).toHaveLength(1);
    expect(nearRequests.at(-1)[0]).toMatch(/^Sigiriya@7\.9\d{1,2},80\.7\d{1,2}$/);
    expect(nearRequests.at(-1)[0]).not.toBe('Sigiriya@7.95,80.76');
  });
});

test.describe('never in the way (D17)', () => {
  test('an empty answer leaves the block hidden', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [] } });
    await goStep3(page);
    await page.waitForTimeout(300);
    await expect(block(page)).toBeHidden();
    await expect(page.locator('#sum-experiences')).toBeHidden();
  });

  test('a 500 hides the block and the booking still completes', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { status: 500 } });
    await goStep3(page);
    await page.waitForTimeout(300);
    await expect(block(page)).toBeHidden();
    // Step 3's own controls are untouched.
    await expect(page.locator('#n4')).toBeEnabled();
    await fillContact(page);
    const bookingP = page.waitForRequest('**/bookings/single');
    const checkoutP = page.waitForRequest('**/bookings/*/checkout');
    await page.click('#pay-btn');
    expect('experienceIds' in JSON.parse((await bookingP).postData())).toBe(false);
    await checkoutP;
  });

  test('an answer slower than 3 seconds is dropped; the block never appears', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA], delayMs: 3600 } });
    await goStep3(page);
    await page.waitForTimeout(4200);
    await expect(block(page)).toBeHidden();
  });

  test('a name from the API is text, never markup', async ({ page }) => {
    const evil = exp({ id: '44444444-4444-4444-8444-444444444444', name: '"><img src=x onerror="window.__xss=1">', partnerName: '<b>P</b>' });
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [{ place: 'Sigiriya', items: [evil] }] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(1);
    await expect(block(page).locator('.xp-row')).toContainText('"><img src=x onerror="window.__xss=1">');
    await block(page).locator('.xp-btn').click();
    await expect(page.locator('#sum-experiences')).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(block(page).locator('.xp-meta')).toContainText('<b>P</b>');
    await expect(block(page).locator('.xp-meta b')).toHaveCount(0);
    await expect(page.locator('#sum-experiences-list b')).toHaveCount(0);
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 375, height: 760 } });

  test('375px: nothing overflows sideways, the name is not truncated, and price and button sit under the meta line', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(3);
    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const rows = [...document.querySelectorAll('#experiences-block .xp-row')];
      const r = rows[0];
      const name = r.querySelector('.xp-name');
      return {
        pageOverflow: root.scrollWidth - root.clientWidth,
        rowRightMax: Math.max(...rows.map((x) => x.getBoundingClientRect().right)),
        vw: window.innerWidth,
        nameClipped: rows.some((x) => { const n = x.querySelector('.xp-name'); return n.scrollWidth > n.clientWidth; }),
        nameWrap: getComputedStyle(name).whiteSpace,
        metaBottom: r.querySelector('.xp-meta').getBoundingClientRect().bottom,
        buyTop: r.querySelector('.xp-buy').getBoundingClientRect().top,
        photoW: r.querySelector('.xp-photo').getBoundingClientRect().width,
        btnH: r.querySelector('.xp-btn').getBoundingClientRect().height,
        moreH: r.querySelector('.xp-more').getBoundingClientRect().height,
        btnRightMax: Math.max(...rows.map((x) => x.querySelector('.xp-btn').getBoundingClientRect().right)),
        rowRightMin: Math.min(...rows.map((x) => x.getBoundingClientRect().right)),
      };
    });
    expect(m.pageOverflow).toBeLessThanOrEqual(0);
    expect(m.rowRightMax).toBeLessThanOrEqual(m.vw);
    expect(m.nameClipped).toBe(false);
    expect(m.nameWrap).toBe('normal');
    expect(m.buyTop).toBeGreaterThanOrEqual(m.metaBottom - 1);
    expect(m.photoW).toBe(64);
    // Touch targets (reviewer note): the Request button is a full 44px tall on phones, and the
    // "Details ›" link has a 32px tap area even though it still looks like small text.
    expect(m.btnH).toBeGreaterThanOrEqual(44);
    expect(m.moreH).toBeGreaterThanOrEqual(32);
    expect(m.btnRightMax).toBeLessThanOrEqual(m.rowRightMin);

    // The tap works here too, and the summary line lives in the mobile sheet (#summary).
    await block(page).locator('.xp-btn').first().click();
    await expect(page.locator('#summary #sum-experiences')).toHaveCount(1);
  });
});

// ── Live Tripadvisor ratings (spec D22) ─────────────────────────────────────────────────────────
// GET /experiences/ratings is asked once, AFTER the rows render, for the rendered ids. A rating is
// the Tripadvisor bubble image (served from Tripadvisor's own URL) + "N reviews", linked to the
// listing. It never delays, hides or reflows the rows when it is absent or fails.
const TA_IMG = 'https://www.tripadvisor.com/img/cdsi/img2/ratings/traveler/4.5-12345-5.svg';
const TA_URL = 'https://www.tripadvisor.com/Attraction_Review-g1-d6789012-Reviews-Spa.html';
const rating = (o) => ({ id: MASSAGE.id, rating: 4.5, numReviews: 312, ratingImageUrl: TA_IMG, webUrl: TA_URL, ...o });

test.describe('Tripadvisor ratings on the rows', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://www.tripadvisor.com/img/**', (r) =>
      r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="75" height="15"/>' }));
    await page.route(TA_LOGO, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: TA_LOGO_SVG }));
  });

  // Tripadvisor's display rules: the logo (>= 20px tall) sits LEFT of the bubbles (>= 55px wide, on white),
  // both inside the one link; the logo is served from the URL the API hands us.
  test('the Tripadvisor logo sits left of the bubbles, at least 20px tall; the bubbles are at least 55px wide; one link', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating()] } });
    await goStep3(page);
    const link = block(page).locator('a.xp-ta');
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
      return { logo: { left: l.left, right: l.right, top: l.top, bottom: l.bottom, h: l.height }, bubbles: { left: b.left, w: b.width, top: b.top, bottom: b.bottom }, span: { left: span.left } };
    });
    expect(m.logo.h).toBeGreaterThanOrEqual(20);
    expect(m.logo.right).toBeLessThanOrEqual(m.bubbles.left + 0.5);   // logo is LEFT of the bubbles
    expect(m.bubbles.left).toBeLessThanOrEqual(m.span.left);          // ...and the count comes after them
    expect(m.logo.top).toBeLessThan(m.bubbles.bottom);                 // same line
    expect(m.bubbles.top).toBeLessThan(m.logo.bottom);
    expect(m.bubbles.w).toBeGreaterThanOrEqual(55);
    const bg = await link.evaluate((a) => { for (let e = a; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)') return c; } return 'none'; });
    expect(bg).toBe('rgb(255, 255, 255)');
  });

  test('no logo in the answer (or one that is not https) means no rating is shown at all', async ({ page }) => {
    for (const logoUrl of [null, 'http://static.tacdn.com/x.svg', 'javascript:window.__xss=1']) {
      await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating()], logoUrl } });
      await goStep3(page);
      await expect(block(page).locator('.xp-row')).toHaveCount(3);
      await page.waitForTimeout(400);
      await expect(block(page).locator('.xp-ta')).toHaveCount(0);
    }
  });

  test('a rating appears under the meta line: the bubble image, "312 reviews", linked to the listing in a new tab', async ({ page }) => {
    const { ratingRequests } = await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating()] } });
    await goStep3(page);
    const row = block(page).locator('.xp-row').first();
    const link = row.locator('a.xp-ta');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', TA_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toContainText('312 reviews');
    const img = link.locator('img.xp-ta-bubbles');
    await expect(img).toHaveAttribute('src', TA_IMG);
    await expect(img).toHaveAttribute('alt', 'Tripadvisor rating 4.5 of 5');
    // Under the meta line, above "Details ›".
    const order = await row.evaluate((r) => {
      const y = (sel) => r.querySelector(sel).getBoundingClientRect().top;
      return [y('.xp-meta'), y('.xp-ta'), y('.xp-more')];
    });
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    // One request, for exactly the rendered ids; the unrated rows get nothing.
    expect(ratingRequests).toHaveLength(1);
    expect(ratingRequests[0].sort()).toEqual([MASSAGE.id, COOKING.id, SAFARI.id].sort());
    await expect(block(page).locator('a.xp-ta')).toHaveCount(1);
  });

  test('a rating does not change what Request does or the Total', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating()] } });
    await goStep3(page);
    await expect(block(page).locator('a.xp-ta')).toHaveCount(1);
    await block(page).locator('.xp-btn').first().click();
    await expect(block(page).locator('.xp-btn').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(block(page).locator('a.xp-ta')).toHaveCount(1);
  });

  test('a failed ratings call leaves the rows exactly as they were', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { status: 500 } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(3);
    await page.waitForTimeout(400);
    await expect(block(page).locator('.xp-ta')).toHaveCount(0);
    await expect(block(page)).not.toContainText(/tripadvisor|reviews/i);
  });

  test('no ratings (the dormant default) shows nothing and reserves no space', async ({ page }) => {
    const { ratingRequests } = await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(3);
    await expect.poll(() => ratingRequests.length).toBe(1);
    await expect(block(page).locator('.xp-ta')).toHaveCount(0);
  });

  test('a ratings answer slower than 3 seconds is dropped; the rows stay', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating()], delayMs: 3600 } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(3);
    await page.waitForTimeout(4200);
    await expect(block(page).locator('.xp-ta')).toHaveCount(0);
  });

  test('malformed or hostile answers are ignored: a javascript: link, a foreign image, a bad rating', async ({ page }) => {
    const bad = [
      rating({ webUrl: 'javascript:window.__xss=1' }),
      rating({ id: COOKING.id, ratingImageUrl: 'data:image/svg+xml,<svg/>' }),
      rating({ id: SAFARI.id, rating: 'five' }),
    ];
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: bad } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(3);
    await page.waitForTimeout(400);
    await expect(block(page).locator('.xp-ta')).toHaveCount(0);
    expect(await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') || '')))).toBe(false);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('quotes and angle brackets in the answer stay text (attributes are double-quoted)', async ({ page }) => {
    const url = 'https://www.tripadvisor.com/x?a="onmouseover="window.__xss=1&b=\'<i>';
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating({ webUrl: url })] } });
    await goStep3(page);
    const link = block(page).locator('a.xp-ta');
    await expect(link).toHaveCount(1);
    expect(await link.evaluate((a) => a.getAttributeNames().sort())).toEqual(['class', 'href', 'rel', 'target']);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('a singular review count reads "1 review"', async ({ page }) => {
    await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating({ numReviews: 1 })] } });
    await goStep3(page);
    await expect(block(page).locator('a.xp-ta')).toContainText(/^\s*1 review\s*$/);
  });

  test('more than 6 rows: only the first 6 ids are asked about', async ({ page }) => {
    const many = Array.from({ length: 8 }, (_, i) => exp({ id: `aaaaaaaa-0000-4000-8000-00000000000${i}`, name: `Exp ${i}`, slug: `e${i}` }));
    const { ratingRequests } = await gotoBooking(page, { query: PRIVATE, experiences: { stops: [{ place: 'Sigiriya', items: many }] } });
    await goStep3(page);
    await expect(block(page).locator('.xp-row')).toHaveCount(8);
    await expect.poll(() => ratingRequests.length).toBe(1);
    expect(ratingRequests[0]).toEqual(many.slice(0, 6).map((e) => e.id));
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 760 } });
    test('375px: with a rating nothing overflows and the rating link is not clipped', async ({ page }) => {
      await gotoBooking(page, { query: PRIVATE, experiences: { stops: [SIGIRIYA] }, ratings: { ratings: [rating()] } });
      await goStep3(page);
      const link = block(page).locator('a.xp-ta');
      await expect(link).toHaveCount(1);
      const m = await page.evaluate(() => {
        const root = document.documentElement, a = document.querySelector('#experiences-block a.xp-ta'), row = a.closest('.xp-row');
        const r = a.getBoundingClientRect(), rr = row.getBoundingClientRect();
        return { overflow: root.scrollWidth - root.clientWidth, right: r.right, rowRight: rr.right, h: r.height };
      });
      expect(m.overflow).toBeLessThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(m.rowRight);
      expect(m.h).toBeGreaterThanOrEqual(32);   // a tap target, not a 14px sliver
      expect(m.h, 'logo + bubbles + count stay on one line at 375px').toBeLessThan(40);
    });
  });
});
