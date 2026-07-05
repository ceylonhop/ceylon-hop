# Booking access lockdown + customer self-service view — design

**Date:** 2026-07-05
**Status:** approved (design), pending spec review
**Milestone:** customer-facing #2 (from the 2026-07-05 milestone review)

## Problem

`GET /bookings/:id` is **unauthenticated**. Anyone who has (or guesses) a booking UUID
gets the full record back — customer name, email, WhatsApp, country, route, and pricing.
Harmless with only test data in the DB; a real PII-exposure the moment paying customers
exist. There is also no way for a customer to look their booking back up after they close
the confirmation page.

This milestone does two things at once:
1. **Security:** stop `GET /bookings/:id` being an open PII endpoint.
2. **UX:** give the customer a signed link to a **view-only** "your booking" page (status,
   trip details, amounts) that they receive by email.

Scope for v1 is **view-only** (owner decision, 2026-07-05). Paying the balance
(milestone #3), self-cancel / change (refund-ladder work), and WhatsApp delivery are
explicitly out of scope and become their own milestones.

## Decisions

| # | Decision |
|---|----------|
| D1 | **Stateless signed token (HMAC).** No DB storage. Token = `base64url(JSON payload)` + `.` + hex HMAC-SHA256 of that body, verified with `timingSafeEqual` — the exact shape already in `api/src/lib/opsAuth.ts`. Chosen over a stored random token because view-only links never need per-link revocation, and this needs no migration. |
| D2 | **No expiry in v1.** Payload is just `{ id }`. A customer can view their own booking anytime, including after travel, for their records. (Revocation, if ever needed, is a secret rotation — acceptable.) |
| D3 | **Dedicated secret `BOOKING_LINK_SECRET`.** Not shared with `OPS_SESSION_SECRET`, so customer-link lifetime is decoupled from ops-session-secret rotation, and an ops-session cookie can never be replayed as a booking token (different key). Dev default `dev-booking-link-secret-change-me`, like the ops secret. Added to the go-live checklist. |
| D4 | **Replace the open read with a token-gated one.** Add `GET /bookings/view?t=<token>`; **remove the bare unauthenticated `GET /bookings/:id`** (nothing calls it — the front-end only uses `POST /bookings/:id/checkout`, and internal callers use the repo `bookings.get()` directly, not the HTTP route). |
| D5 | **Customer-safe projection.** The endpoint never returns the raw `Booking`. A `projectBooking()` returns only display fields (see below) — no `id`, no `channel`, and only the customer's **first name**, not their email/phone. |
| D6 | **New front-end page `manage.html`** — a *new* file, so it is not covered by the frozen-file rule (only the existing listed files are frozen; new HTML is allowed). Styled with the existing `site.css`. |
| D7 | **Email link.** A "View your booking" button in the **confirmation** email and the **pre-trip reminder**, pointing at `${APP_BASE_URL}/manage.html?t=<token>`. |
| D8 | **Rate-limited** like the other public reads (reuse the existing public `rateLimit`). |

## Architecture

Four small, independently-testable units:

### 1. `api/src/lib/bookingToken.ts` (new)
```
signBookingToken(bookingId: string, secret: string): string
verifyBookingToken(token: string | undefined, secret: string): string | null   // → bookingId, or null
```
Mirrors `opsAuth.signSession/verifySession`: `body = base64url(JSON.stringify({ id }))`,
`sig = hmacSHA256(body, secret)`, token = `` `${body}.${sig}` ``. Verify splits on `.`,
recomputes the sig, `timingSafeEqual`-compares, and on match returns the `id`. Any
malformed / tampered / wrong-secret input returns `null` (never throws).
- **Depends on:** `node:crypto` only.
- **Why isolated:** pure function, no I/O — trivially unit-tested for forgery resistance.

### 2. `GET /bookings/view` route (in `api/src/routes/bookings.ts`)
- Read `t` from the query. `verifyBookingToken(t, secret)` → `id` or `401 { error: 'invalid_link' }`.
- `bookings.get(id)` → `404 { error: 'not_found' }` if absent (a valid signature for a
  since-deleted booking).
- Return `200 projectBooking(booking)`.
- Behind the public rate limiter.
- **Remove** the existing `r.get('/:id')` handler.

### 3. `projectBooking(booking): CustomerBookingView` (in `bookings.ts` or a small helper)
Branches on `mode`. Returns exactly:
```
{
  reference, status, mode,               // 'single' | 'trip' | 'shared'
  firstName,                             // input.customer.firstName only
  from, to,                              // single/shared; trip → stops[0] / stops[last]
  date | 'to confirm', time | 'to confirm',
  adults, children, bags,
  vehicleType,                           // where applicable
  currency, total, amountDueNow, balanceDue  // balanceDue = total − (amountDueNow ?? total)
}
```
Never includes `id`, `channel`, `createdAt`, `distanceKm/durationMin`, or any
`input.customer` field beyond `firstName`. (Driver/fulfilment data lives in the separate
`RideOps` repo and is never loaded here; margin lives on quotes, never on a booking.)

### 4. `manage.html` (new front-end file)
- Reads `?t=<token>` from `location.search`.
- `fetch(`${window.CEYLON_HOP_API}/bookings/view?t=${t}`)`.
- Renders a clean status/receipt card (reference, status badge, route, date/time, pax,
  vehicle, total + balance-due) with `site.css`.
- **Error states:** no/invalid token or `401` → friendly "This link isn't valid — message
  us on WhatsApp and we'll pull up your booking." `404` → "We couldn't find this booking."
  Network error → retry affordance. Never a blank page.
- Also carries the standard M17 client-error beacon (parity with the other pages).

### 5. Email link helper (in `api/src/services/notifications.ts`)
- `manageUrl(booking, baseUrl, secret): string` → `` `${baseUrl}/manage.html?t=${signBookingToken(booking.id, secret)}` ``.
- The **caller** (payment webhook for confirmation; scheduler for the reminder) builds the
  URL from `config.APP_BASE_URL` + `config.BOOKING_LINK_SECRET` and passes it into the send
  function as an optional `links: { manage?: string }` argument (additive, optional — keeps
  the email-adapter seam clean and unit-testable without config).
- The confirmation and reminder templates render a "View your booking" button when
  `links.manage` is present.

## Data flow

```
paid webhook / reminder job
  → manageUrl(booking, APP_BASE_URL, BOOKING_LINK_SECRET)
  → email "View your booking" button
customer clicks
  → manage.html?t=<token>
  → GET /bookings/view?t=<token>
  → verifyBookingToken → id → bookings.get → projectBooking → 200
  → page renders status/receipt
```

## Error handling
- Missing/blank/tampered/wrong-secret token → `401 invalid_link` (no distinction between
  "malformed" and "bad signature" — don't leak which).
- Valid signature, unknown id → `404 not_found`.
- Page turns every failure into human-readable copy with a WhatsApp fallback.
- Token verify never throws (fails closed to `null`).

## Access model (no login — why this is safe)

The site has no customer accounts, and we deliberately don't add one. **The signed link is
the credential** (a "capability URL" — the same model as an airline "Manage My Booking"
link, an Uber/DoorDash order-tracking link, or a password-reset link). The customer receives
it in the confirmation email sent to the address they booked with, so their **email inbox is
the trust boundary** — something they already control.

On link forwarding/sharing (owner decision 2026-07-05: **link-only**, no challenge, no
expiry):
- The link is **view-only, single-booking** — a holder can read one booking and cannot
  change, pay, cancel, or reach any other booking (no enumeration).
- The projection deliberately omits contact details (email, phone, country, last name),
  so a forwarded link reveals only first name + trip facts + amounts.
- **It exposes nothing the confirmation email itself doesn't already contain**, and that
  email is equally forwardable — so the page is not a new exposure surface beyond what we
  already send. This is why link-only is acceptable here.
- Reconsider a last-name challenge and/or link expiry only if the projection later grows to
  include sensitive data, or if bookings start carrying data the customer shouldn't be able
  to re-share.

## Security notes
- HMAC signature is unforgeable without `BOOKING_LINK_SECRET`; UUIDs can't be enumerated
  into valid tokens.
- `timingSafeEqual` comparison (reused pattern) avoids signature timing oracles.
- Projection is an allow-list, so new internal fields added to `Booking` later can't
  silently leak.
- Dedicated secret prevents cross-replay with ops session cookies.
- Residual, accepted for v1: whoever holds the link can view that one booking (view-only,
  the customer's own data) — same trust model as any "view your order" link; no expiry.

## Environment
- New: `BOOKING_LINK_SECRET` (dev default provided; **must be set to a strong random value
  at launch** — add a go-live-checklist row next to `OPS_SESSION_SECRET`).
- Reuses existing `APP_BASE_URL` (the front-end origin; already flips to the apex at launch).

## Testing
- **`bookingToken.test.ts`:** round-trip sign→verify returns the id; tampered body → null;
  tampered sig → null; wrong secret → null; empty/garbage/no-dot input → null.
- **Route tests (`bookings.test.ts`):** valid token → 200 with the projected fields; assert
  the response has **no** `id`, `channel`, `email`, `whatsapp`, `country`; missing/blank `t`
  → 401; bad signature → 401; valid signature for unknown id → 404; rate-limit applies.
- **Notifications test:** given `links.manage`, the confirmation HTML **and** text contain
  the URL; without it, no button and no broken link.
- **e2e (`web-tests/e2e`):** load `manage.html?t=<token>` with the API stubbed → renders the
  status card; invalid token (stub 401) → friendly error state, not a blank page.

## Out of scope (become their own milestones)
- Paying the outstanding balance (milestone #3).
- Self-cancel / date or pickup change (needs the cancellation/refund-policy work).
- WhatsApp delivery of the link.
- Token expiry / per-link revocation.
- Driver / pickup-assignment details on the page.

## Build steps (for the implementation plan)
1. `bookingToken.ts` + unit tests (TDD).
2. `BOOKING_LINK_SECRET` in `config.ts`.
3. `projectBooking()` + `GET /bookings/view`, remove bare `GET /:id`, + route tests.
4. `manageUrl()` + optional `links` arg in the confirmation & reminder emails + tests;
   wire the callers (webhook, scheduler) to pass it.
5. `manage.html` (+ client-error beacon) + e2e.
6. Go-live-checklist row for `BOOKING_LINK_SECRET`.
