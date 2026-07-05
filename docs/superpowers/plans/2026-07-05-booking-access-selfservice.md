# Booking Access Lockdown + Customer Self-Service View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unauthenticated `GET /bookings/:id` with a view-only, HMAC-signed "manage my booking" link that customers receive by email, exposing only a customer-safe projection.

**Architecture:** A stateless signed token (`base64url(json).hmac`, mirroring `opsAuth.ts`) encodes a booking id. A new `GET /bookings/view?t=<token>` verifies it and returns an allow-listed projection; the open `GET /:id` is removed. A new (non-frozen) `manage.html` renders it; the confirmation and reminder emails carry the link.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Playwright · `node:crypto` (no new deps).

## Global Constraints

- Backend code lives in `api/` only. `manage.html` is a **new** root file — allowed (the freeze covers only the existing listed files; new HTML is permitted).
- TDD: write the failing test, run it red, implement, run it green, commit. Paste red→green in the PR.
- `cd api && npm run check` must pass before any PR (typecheck + lint + test).
- Money is integer minor units (cents); IDs are uuid strings.
- No new external services; no new npm dependencies.
- HMAC token shape is fixed and identical to `opsAuth`: `base64url(JSON).hex-hmac-sha256`, verified with `timingSafeEqual`.
- Secret name is exactly `BOOKING_LINK_SECRET`; dev default exactly `dev-booking-link-secret-change-me`.

---

## File Structure

- Create `api/src/lib/bookingToken.ts` — sign/verify the capability token (pure, `node:crypto` only).
- Create `api/src/lib/bookingToken.test.ts` — token unit tests.
- Modify `api/src/config.ts` — add `BOOKING_LINK_SECRET`.
- Modify `api/src/routes/bookings.ts` — add `projectBooking()` + `CustomerBookingView`, add `GET /view`, remove `GET /:id`, add `linkSecret` to the factory deps.
- Modify `api/src/routes/bookings.test.ts` — endpoint tests.
- Modify `api/src/app.ts` — pass `bookingLinkSecret` through to `bookingRoutes`.
- Modify `api/src/services/notifications.ts` — `manageUrl()` helper + a `manageButton()` block + optional `links` arg on confirmation & reminder.
- Modify `api/src/services/notifications.test.ts` — link-present/absent tests.
- Modify `api/src/routes/webhooks.ts` and the admin-jobs route calling `runScheduledNotifications` — pass the manage link.
- Modify `api/src/services/scheduler.ts` — thread `baseUrl` + `linkSecret` through its deps to the reminder.
- Create `manage.html` — the customer page (+ M17 error beacon).
- Create `web-tests/e2e/manage.spec.js` — e2e for the page.
- Modify `docs/go-live-checklist.md` — add a `BOOKING_LINK_SECRET` row.

---

## Task 1: Capability token library

**Files:**
- Create: `api/src/lib/bookingToken.ts`
- Test: `api/src/lib/bookingToken.test.ts`

**Interfaces:**
- Produces: `signBookingToken(bookingId: string, secret: string): string` and `verifyBookingToken(token: string | undefined, secret: string): string | null` (returns the booking id or null).

- [ ] **Step 1: Write the failing test**

Create `api/src/lib/bookingToken.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { signBookingToken, verifyBookingToken } from './bookingToken';

const S = 'test-secret';

describe('bookingToken', () => {
  it('round-trips a booking id', () => {
    const t = signBookingToken('abc-123', S);
    expect(verifyBookingToken(t, S)).toBe('abc-123');
  });

  it('rejects a tampered body (forged id, kept signature)', () => {
    const t = signBookingToken('abc-123', S);
    const sig = t.split('.')[1];
    const forgedBody = Buffer.from(JSON.stringify({ id: 'other' })).toString('base64url');
    expect(verifyBookingToken(`${forgedBody}.${sig}`, S)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const t = signBookingToken('abc-123', S);
    const last = t.slice(-1);
    expect(verifyBookingToken(t.slice(0, -1) + (last === '0' ? '1' : '0'), S)).toBeNull();
  });

  it('rejects a wrong secret', () => {
    const t = signBookingToken('abc-123', S);
    expect(verifyBookingToken(t, 'other-secret')).toBeNull();
  });

  it('rejects undefined / empty / no-dot / garbage input', () => {
    expect(verifyBookingToken(undefined, S)).toBeNull();
    expect(verifyBookingToken('', S)).toBeNull();
    expect(verifyBookingToken('no-dot-here', S)).toBeNull();
    expect(verifyBookingToken('....', S)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/lib/bookingToken.test.ts`
Expected: FAIL — `Failed to resolve import "./bookingToken"`.

- [ ] **Step 3: Write the implementation**

Create `api/src/lib/bookingToken.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

// A view-only capability token for ONE booking. Same shape as the ops session cookie
// (opsAuth.ts): base64url(json).hmac, verified with timingSafeEqual. No expiry — a customer
// can reopen their booking anytime. Signed with a DEDICATED secret (BOOKING_LINK_SECRET) so
// it can never be cross-replayed with the ops session cookie.
function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function signBookingToken(bookingId: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ id: bookingId })).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifyBookingToken(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const id = (parsed as { id?: unknown })?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/lib/bookingToken.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/bookingToken.ts api/src/lib/bookingToken.test.ts
git commit -m "feat(api): HMAC capability token for view-only booking links"
```

---

## Task 2: Tokenized view endpoint + projection (removes the open GET /:id)

**Files:**
- Modify: `api/src/config.ts` (add `BOOKING_LINK_SECRET`)
- Modify: `api/src/routes/bookings.ts:63` (deps type), `:258-263` (replace `GET /:id`), add `projectBooking`
- Modify: `api/src/app.ts:145` (pass secret) and its deps type (~`:30-45`)
- Modify: `api/src/routes/bookings.test.ts`
- Modify: `docs/go-live-checklist.md`

**Interfaces:**
- Consumes: `verifyBookingToken` (Task 1).
- Produces: `projectBooking(b: Booking): CustomerBookingView`; HTTP `GET /bookings/view?t=<token>` → `200 CustomerBookingView` | `401 {error:'invalid_link'}` | `404 {error:'not_found'}`. `bookingRoutes` deps gain `linkSecret: string`; `createApp` deps gain optional `bookingLinkSecret?: string`.

- [ ] **Step 1: Add the config var**

In `api/src/config.ts`, after the `OPS_SESSION_SECRET` line (~`:37`):
```ts
  // Signs the view-only "manage my booking" link tokens (customer-facing #2). A DEDICATED
  // secret (not OPS_SESSION_SECRET) so customer links and ops sessions can't cross-replay.
  // Set to a strong unique value at launch — see docs/go-live-checklist.md.
  BOOKING_LINK_SECRET: z.string().default('dev-booking-link-secret-change-me'),
```
(No production boot-check: a defaulted secret only forges a *view-only* link to a booking whose id you already have — no worse than the confirmation email — so it must not block launch. The go-live row covers setting it.)

- [ ] **Step 2: Write the failing endpoint tests**

In `api/src/routes/bookings.test.ts`, add (adjust the seed helper to match the file's existing pattern for creating a booking + app):
```ts
import { signBookingToken } from '../lib/bookingToken';

describe('GET /bookings/view (tokenized customer view)', () => {
  const SECRET = 'dev-booking-link-secret-change-me';

  it('returns a customer-safe projection for a valid token', async () => {
    const bookings = new InMemoryBookingRepo();
    const created = await bookings.create({
      mode: 'single', total: 6000, amountDueNow: 6000, currency: 'USD',
      input: {
        from: 'Colombo Airport (CMB)', to: 'Kandy', vehicleType: 'car',
        adults: 2, children: 0, bags: 1,
        customer: { firstName: 'Maya', lastName: 'Fernandez', email: 'maya@example.com', whatsapp: '+94771234567', country: 'Spain' },
      },
    });
    const app = createApp({ bookings });
    const res = await app.request(`/bookings/view?t=${signBookingToken(created.id, SECRET)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reference).toBe(created.reference);
    expect(body.from).toBe('Colombo Airport (CMB)');
    expect(body.firstName).toBe('Maya');
    expect(body.totalCents).toBe(6000);
    // Allow-list: never leak the id, channel, or contact details.
    for (const leak of ['id', 'channel', 'email', 'whatsapp', 'country', 'lastName']) {
      expect(JSON.stringify(body)).not.toContain(leak === 'email' ? 'maya@example.com' : leak === 'whatsapp' ? '+94771234567' : leak === 'country' ? 'Spain' : leak === 'lastName' ? 'Fernandez' : `"${leak}"`);
    }
  });

  it('401s a missing or invalid token', async () => {
    const app = createApp();
    expect((await app.request('/bookings/view')).status).toBe(401);
    expect((await app.request('/bookings/view?t=garbage')).status).toBe(401);
  });

  it('404s a valid signature for an unknown booking', async () => {
    const app = createApp();
    const res = await app.request(`/bookings/view?t=${signBookingToken('no-such-id', SECRET)}`);
    expect(res.status).toBe(404);
  });
});
```
(If `InMemoryBookingRepo`/`createApp` aren't already imported in this test file, add them — follow the imports the existing tests in this file use.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && npx vitest run src/routes/bookings.test.ts -t "tokenized customer view"`
Expected: FAIL — `404`/route-not-found or `projectBooking` undefined.

- [ ] **Step 4: Add the projection + view route, remove GET /:id**

In `api/src/routes/bookings.ts`, add the import near the top:
```ts
import { verifyBookingToken } from '../lib/bookingToken';
```
Add `linkSecret` to the factory deps type at `:63` (`export function bookingRoutes(deps: { ... , linkSecret: string })`) and add this exported projection above the routes:
```ts
// Customer-safe view of a booking (allow-list). Only display fields + first name — never the
// raw id, channel, or contact details — so a forwarded link reveals nothing the confirmation
// email doesn't already. Driver/fulfilment lives in RideOps (not loaded); margin is on quotes.
export interface CustomerBookingView {
  reference: string;
  status: string;
  mode: 'single' | 'trip' | 'shared';
  firstName: string;
  from: string;
  to: string;
  date: string;   // ISO date or 'to confirm'
  time: string;   // HH:mm or 'to confirm'
  travellers: number;
  bags: number | null;
  vehicleType: string | null;
  currency: string;
  totalCents: number;
  amountDueNowCents: number;
  balanceDueCents: number;
}

export function projectBooking(b: Booking): CustomerBookingView {
  const dueNow = b.amountDueNow ?? b.total;
  const base = {
    reference: b.reference, status: b.status, mode: b.mode,
    firstName: b.input.customer.firstName, currency: b.currency,
    totalCents: b.total, amountDueNowCents: dueNow,
    balanceDueCents: Math.max(0, b.total - dueNow),
  };
  if (b.mode === 'single') {
    return { ...base, from: b.input.from, to: b.input.to,
      date: b.input.date ?? 'to confirm', time: b.input.time ?? 'to confirm',
      travellers: b.input.adults + b.input.children, bags: b.input.bags, vehicleType: b.input.vehicleType };
  }
  if (b.mode === 'trip') {
    const stops = b.input.stops;
    return { ...base, from: stops[0], to: stops[stops.length - 1],
      date: b.input.dates?.[0] ?? 'to confirm', time: 'to confirm',
      travellers: b.input.pax, bags: null, vehicleType: b.input.vehicleType };
  }
  return { ...base, from: b.input.from ?? 'Pickup', to: b.input.to ?? 'Drop-off',
    date: b.input.date ?? 'to confirm', time: 'to confirm',
    travellers: b.input.seats, bags: null, vehicleType: null };
}
```
Replace the `r.get('/:id', ...)` block at `:258-263` with:
```ts
  // 1.5 — view a booking via a signed capability token (customer-facing #2). Replaces the
  // old unauthenticated GET /:id (nothing calls it: the site uses POST /:id/checkout and
  // internal callers use the repo). Returns only a customer-safe projection.
  r.get('/view', async (c) => {
    const id = verifyBookingToken(c.req.query('t'), deps.linkSecret);
    if (!id) return c.json({ error: 'invalid_link' }, 401);
    const booking = await deps.bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    return c.json(projectBooking(booking), 200);
  });
```
(Ensure the factory destructures `deps` or references `deps.linkSecret`/`deps.bookings` consistently with the surrounding code.)

- [ ] **Step 5: Wire the secret through `createApp`**

In `api/src/app.ts`: add `bookingLinkSecret?: string;` to the deps type (~`:30-45`), then at `:145` change the mount to:
```ts
  app.route('/bookings', bookingRoutes({ bookings, payments, adapter, departures, maps, conciergeTasks, linkSecret: deps.bookingLinkSecret ?? config.BOOKING_LINK_SECRET }));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && npx vitest run src/routes/bookings.test.ts`
Expected: PASS (new view tests green; existing booking tests still green — the removed `GET /:id` had no other dependants, but if any test referenced it, update it to `/view`).

- [ ] **Step 7: Add the go-live checklist row**

In `docs/go-live-checklist.md`, add to the Render env-var table (near `OPS_SESSION_SECRET`):
```markdown
| `BOOKING_LINK_SECRET` | `dev-booking-link-secret-change-me` (default) | **strong random secret** (`openssl rand -hex 32`) — signs customers' view-only "manage my booking" links |
```
And a checklist line under the env list:
```markdown
- [ ] `BOOKING_LINK_SECRET` set to a strong random value (customer booking-view links)
```

- [ ] **Step 8: Full check + commit**

Run: `cd api && npm run check`
Expected: PASS.
```bash
git add api/src/config.ts api/src/routes/bookings.ts api/src/routes/bookings.test.ts api/src/app.ts docs/go-live-checklist.md
git commit -m "feat(api): tokenized GET /bookings/view + safe projection; remove open GET /:id"
```

---

## Task 3: Manage-booking link in the confirmation & reminder emails

**Files:**
- Modify: `api/src/services/notifications.ts` (`manageUrl`, `manageButton`, optional `links` arg)
- Modify: `api/src/services/notifications.test.ts`
- Modify: `api/src/routes/webhooks.ts:71` (confirmation caller)
- Modify: `api/src/services/scheduler.ts` (reminder caller + deps) and the admin-jobs route that calls `runScheduledNotifications`

**Interfaces:**
- Consumes: `signBookingToken` (Task 1), `config.APP_BASE_URL`, `config.BOOKING_LINK_SECRET`.
- Produces: `manageUrl(booking: Booking, baseUrl: string, secret: string): string`; `sendBookingConfirmation(booking, email, links?: { manage?: string })`; `sendTripReminder(booking, email, links?: { manage?: string })`.

- [ ] **Step 1: Write the failing notification test**

In `api/src/services/notifications.test.ts`, add:
```ts
import { manageUrl, sendBookingConfirmation } from './notifications';

describe('manage-booking link', () => {
  it('builds a signed manage URL from the base + secret', () => {
    const url = manageUrl(single, 'https://ceylonhop.com', 'sek');
    expect(url).toMatch(/^https:\/\/ceylonhop\.com\/manage\.html\?t=.+\..+$/);
  });

  it('renders a View-your-booking link when provided, and omits it otherwise', async () => {
    const withLink = new FakeEmailAdapter();
    await sendBookingConfirmation(single, withLink, { manage: 'https://ceylonhop.com/manage.html?t=TOK' });
    expect(withLink.sent[0].html).toContain('https://ceylonhop.com/manage.html?t=TOK');
    expect(withLink.sent[0].text).toContain('https://ceylonhop.com/manage.html?t=TOK');

    const noLink = new FakeEmailAdapter();
    await sendBookingConfirmation(single, noLink);
    expect(noLink.sent[0].html).not.toContain('manage.html');
  });
});
```
(Reuse the file's existing `single` fixture and its email fake — match the existing import for the fake adapter.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && npx vitest run src/services/notifications.test.ts -t "manage-booking link"`
Expected: FAIL — `manageUrl` not exported.

- [ ] **Step 3: Implement the helper, button, and threading**

In `api/src/services/notifications.ts`:
```ts
import { signBookingToken } from '../lib/bookingToken';

// Customer's view-only "manage my booking" link. baseUrl = front-end origin (APP_BASE_URL).
export function manageUrl(booking: Booking, baseUrl: string, secret: string): string {
  return `${baseUrl.replace(/\/$/, '')}/manage.html?t=${signBookingToken(booking.id, secret)}`;
}

// A CTA block consistent with the other block helpers (returns a table row for page()).
function manageButton(url: string): string {
  return `<tr><td style="padding:4px 32px 26px">`
    + `<a href="${url}" style="display:inline-block;background:${TEAL_DEEP};color:#fff;text-decoration:none;`
    + `padding:12px 24px;border-radius:999px;font-weight:700;font-size:.95rem">View your booking</a></td></tr>`;
}
```
Change `renderHtml` to accept an optional link and insert the button after `refCard(...)`:
```ts
function renderHtml(booking: Booking, manageLink?: string): string {
  const first = esc(booking.input.customer.firstName);
  return page(
    brandHeader() +
      introBlock(/* …unchanged… */) +
      refCard(booking, BADGE_PAID) +
      (manageLink ? manageButton(manageLink) : '') +
      routeBlock(booking) +
      /* …rest unchanged… */
      footer(),
  );
}
```
Change `renderText(booking, manageLink?)` to append, when present: `\n\nView your booking: ${manageLink}` (add it into the existing text body array).
Update the senders:
```ts
export async function sendBookingConfirmation(booking: Booking, email: EmailAdapter, links: { manage?: string } = {}): Promise<void> {
  await email.send({
    to: booking.input.customer.email,
    subject: `Your Ceylon Hop booking is confirmed — ${booking.reference}`,
    html: renderHtml(booking, links.manage),
    text: renderText(booking, links.manage),
  });
}
```
Do the same optional `links` threading for `sendTripReminder` (pass `links.manage` into its render path).

- [ ] **Step 4: Run to verify it passes**

Run: `cd api && npx vitest run src/services/notifications.test.ts`
Expected: PASS (new + existing tests green — existing calls still work because `links` defaults to `{}`).

- [ ] **Step 5: Wire the callers**

In `api/src/routes/webhooks.ts` add `import { config } from '../config';` and `import { manageUrl } from '../services/notifications';`, then change `:71`:
```ts
        await sendBookingConfirmation(paid, email, { manage: manageUrl(paid, config.APP_BASE_URL, config.BOOKING_LINK_SECRET) });
```
In `api/src/services/scheduler.ts`, add `baseUrl: string; linkSecret: string;` to the `deps` object of `runScheduledNotifications`, and change the reminder send at `:50`:
```ts
          await sendTripReminder(b, email, { manage: manageUrl(b, baseUrl, linkSecret) });
```
(add `manageUrl` to the import from `./notifications`, and destructure `baseUrl, linkSecret` alongside `bookings, log, email`). In the admin-jobs route that calls `runScheduledNotifications`, pass `baseUrl: config.APP_BASE_URL, linkSecret: config.BOOKING_LINK_SECRET` in the deps object.

- [ ] **Step 6: Full check + commit**

Run: `cd api && npm run check`
Expected: PASS.
```bash
git add api/src/services/notifications.ts api/src/services/notifications.test.ts api/src/routes/webhooks.ts api/src/services/scheduler.ts
git commit -m "feat(api): add view-your-booking link to confirmation + reminder emails"
```

---

## Task 4: `manage.html` customer page + e2e

**Files:**
- Create: `manage.html` (repo root)
- Create: `web-tests/e2e/manage.spec.js`

**Interfaces:**
- Consumes: `GET /bookings/view?t=<token>` → `CustomerBookingView` (Task 2).

- [ ] **Step 1: Write the failing e2e test**

Create `web-tests/e2e/manage.spec.js`:
```js
import { test, expect } from '@playwright/test';

const VIEW = {
  reference: 'CH-ABC12', status: 'paid', mode: 'single', firstName: 'Maya',
  from: 'Colombo Airport (CMB)', to: 'Kandy', date: '2026-08-01', time: '09:00',
  travellers: 2, bags: 1, vehicleType: 'car',
  currency: 'USD', totalCents: 6000, amountDueNowCents: 6000, balanceDueCents: 0,
};

test('renders the booking view for a valid token', async ({ page }) => {
  await page.route('**/bookings/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VIEW) }));
  await page.goto('/manage.html?t=fake-token');
  await expect(page.locator('body')).toContainText('CH-ABC12');
  await expect(page.locator('body')).toContainText('Kandy');
});

test('shows a friendly error for an invalid link', async ({ page }) => {
  await page.route('**/bookings/view*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid_link"}' }));
  await page.goto('/manage.html?t=bad');
  await expect(page.locator('body')).toContainText(/isn.t valid|couldn.t find|WhatsApp/i);
  // never a blank page
  await expect(page.locator('body')).not.toHaveText('');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-tests && npx playwright test manage --reporter=line`
Expected: FAIL — `manage.html` 404s / no matching text.

- [ ] **Step 3: Create the page**

Create `manage.html` (self-contained; reuses `site.css`; carries the M17 beacon copied verbatim from `booking.html:24-29`, and derives the API base the same way):
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your booking · Ceylon Hop</title>
<link rel="stylesheet" href="site.css">
<script>
window.CEYLON_HOP_API = window.CEYLON_HOP_API || 'https://ceylon-hop-api.onrender.com';
(function(){var n=0,A=(window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com');
function r(m,s){if(n>=5)return;n++;try{var b=JSON.stringify({message:String(m||'unknown').slice(0,500),stack:String(s||'').slice(0,1500),url:location.href.slice(0,300),ua:navigator.userAgent.slice(0,300)});(navigator.sendBeacon&&navigator.sendBeacon(A+'/errors/client',new Blob([b],{type:'application/json'})))||fetch(A+'/errors/client',{method:'POST',headers:{'content-type':'application/json'},body:b,keepalive:true}).catch(function(){})}catch(e){}}
window.addEventListener('error',function(e){r(e.message,e.error&&e.error.stack)});
window.addEventListener('unhandledrejection',function(e){var x=e.reason||{};r(x.message||String(x),x.stack)});})();
</script>
<style>
  body{max-width:640px;margin:0 auto;padding:32px 18px;font-family:system-ui,sans-serif}
  .card{border:1px solid #e8e3d4;border-radius:16px;padding:22px;margin-top:16px}
  .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0ece1}
  .ref{font-weight:700;font-size:1.3rem}
  .muted{color:#6b645f}
  .err{text-align:center;padding:40px 16px}
</style>
</head>
<body>
<div id="app"><p class="muted">Loading your booking…</p></div>
<script>
(function(){
  var app = document.getElementById('app');
  var t = new URLSearchParams(location.search).get('t');
  var A = window.CEYLON_HOP_API.replace(/\/$/, '');
  function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}
  function money(cents,cur){return (cur||'USD')+' '+ (cents/100).toFixed(2).replace(/\.00$/,'');}
  function errView(msg){app.innerHTML='<div class="err"><h2>We couldn’t open this booking</h2><p class="muted">'+esc(msg)+'</p><p><a href="https://wa.me/94770000000">Message us on WhatsApp</a> and we’ll pull it up for you.</p></div>';}
  if(!t){ errView('This link isn’t valid.'); return; }
  fetch(A+'/bookings/view?t='+encodeURIComponent(t)).then(function(res){
    if(res.status===401) throw new Error('This link isn’t valid or has changed.');
    if(res.status===404) throw new Error('We couldn’t find this booking.');
    if(!res.ok) throw new Error('Something went wrong. Please try again.');
    return res.json();
  }).then(function(v){
    var rows = [
      ['Route', esc(v.from)+' → '+esc(v.to)],
      ['Date', esc(v.date)], ['Pick-up time', esc(v.time)],
      ['Travellers', esc(v.travellers)],
      ['Vehicle', v.vehicleType?esc(v.vehicleType):'—'],
      ['Total', money(v.totalCents,v.currency)],
      ['Balance due', money(v.balanceDueCents,v.currency)],
    ].map(function(x){return '<div class="row"><span class="muted">'+x[0]+'</span><span>'+x[1]+'</span></div>';}).join('');
    app.innerHTML = '<p class="muted">Hi '+esc(v.firstName)+', here’s your booking.</p>'
      + '<div class="card"><div class="ref">'+esc(v.reference)+'</div>'
      + '<p class="muted">Status: '+esc(v.status)+'</p>'+rows+'</div>';
  }).catch(function(e){ errView(e.message); });
})();
</script>
</body>
</html>
```
(Update the `wa.me` number to the real WhatsApp line before launch.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd web-tests && npx playwright test manage --reporter=line`
Expected: PASS (2 tests). If the static server (`serve-booking.js`) is already running on :4173 from another session serving a different directory, stop it first so Playwright serves this repo root.

- [ ] **Step 5: Commit**

```bash
git add manage.html web-tests/e2e/manage.spec.js
git commit -m "feat(site): manage.html — view-only booking self-service page + e2e"
```

---

## Self-Review

**Spec coverage:** D1 token → Task 1. D2 no expiry (payload `{id}` only) → Task 1. D3 dedicated secret → Task 2 Step 1. D4 view endpoint + remove `/:id` → Task 2. D5 projection allow-list → Task 2 (`projectBooking` + leak assertions). D6 `manage.html` → Task 4. D7 email link (confirmation + reminder) → Task 3. D8 rate limit → inherited (the existing `app.use('/bookings/*', rateLimit(rl))` covers `/bookings/view`; no new code). Env `BOOKING_LINK_SECRET` + go-live row → Task 2. Testing plan → tests in every task. Access-model/link-only decision → design only, no code.

**Placeholder scan:** none — every code step shows complete code; the only "adjust to the file's existing fixture" notes point at concrete, existing patterns.

**Type consistency:** `signBookingToken`/`verifyBookingToken` (Task 1) used identically in Tasks 2 & 3. `CustomerBookingView` fields defined in Task 2 match the e2e fixture in Task 4. `manageUrl(booking, baseUrl, secret)` and `links: { manage?: string }` consistent across Task 3 and its callers.

**Note for the implementer:** `/bookings/view` is already covered by the existing `/bookings/*` rate limiter — do not add a second one. Confirm no remaining test references the removed `GET /:id`; if one exists, repoint it at `/bookings/view` with a signed token.
