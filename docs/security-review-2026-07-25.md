# Security review — 2026-07-25 (partial)

Review of `origin/main` @ `7047afb`, focused on payment integrity, pricing/distance manipulation and
access control.

**Completeness:** the **payment-integrity** pass finished and is below. The **pricing/distance** and
**access-control** passes were cut short by an API session limit before producing findings — treat those
two areas as **not yet reviewed**, which is not the same as clean.

**Fixed so far (commit `f1fa8d9`):** H1 and M2 below. The rest are open.

---

# DO NOT RE-AUDIT — settled areas

Everything in this list was traced end to end and, where noted, proven by running code. **Re-auditing
these wastes budget.** Detail for each sits in the per-pass sections below. If you change the code
underneath one of these, that specific line is void — otherwise treat it as answered.

## Payments and money movement (pass 1)
- PayHere webhook signature: correct algorithm and field order, pinned by an independent literal in
  `payhere.test.ts`. `status_code` is inside the signature; the "signed as failed, flipped to
  success" tamper is rejected and tested.
- The no-delimiter re-split attack on the signed string: attempted and **not** exploitable. Load-bearing
  on the currency check at `webhooks.ts:50` — **do not weaken that line.**
- Length extension on the checkout hash: cannot yield a valid `md5sig`.
- Client amount tampering: `/checkout` accepts no request body at all; `order_id`, `amount` and
  `currency` are server-derived and reconciled at the webhook.
- Replay, refund-flip, and the booking state machine (forward-only allow-list + compare-and-set).
- Refunds: all admin money actions require a human session with `payments:act`; no customer-facing
  refund endpoint; no gateway refund call, so "partial refund > paid" is unreachable.
- Idempotency of booking creation and `/checkout` (unique constraints + in-memory guard).
- No merchant secret, signature or API key is reachable client-side.

## Pricing, distance and inventory (pass 2)
- `quotedTotal` can never undercut a priced booking; the engine wins whenever it prices.
- Bookings never accept a client-supplied distance; km is always server-resolved.
- Shared seat price is DB-authoritative; the extra-bag fee is server-side.
- Wed/Sat service days are enforced server-side, before inventory is touched.
- Seat holds are race-safe (Postgres guarded `UPDATE`; in-memory check-and-increment with no `await`).
  The oversell that was found was a key-choice bug, now fixed — not a race.
- Vehicle capacity is enforced server-side and can only be upgraded, never downgraded.
- Add-ons are an enum with no client-supplied quantity or price; `customPerKmCents` is not
  client-reachable.
- Rate lock binds the rate *card*, not a price, and expiry is enforced at redemption; a customer's
  web quote can never be converted through the ops path.
- Numeric hardening: negative/zero/fractional/`-0` pax, negative distance and numeric strings are all
  rejected; JSON cannot carry `NaN`/`Infinity`.
- `memoizeDistance` does not double-bill Google.

## Access control and injection (pass 3)
- **Stored XSS into the authenticated ops UI:** `ops-ui.html` keeps a consistent `esc()` discipline;
  every customer-controlled field sampled is escaped. The two unescaped interpolations are a
  clipboard text template and a search-filter comparison — neither is an HTML sink.
- **Ops capability checks:** every route carries `requireCap` inline or sits behind a router-level
  `r.use('*', …)` gate. No verb-level asymmetry. The bare `/admin/quote` redirect is deliberately
  exempt and pinned by a test.
- **Customer booking lookup (IDOR):** HMAC-SHA256 with a dedicated secret, length-checked,
  `timingSafeEqual`, UUID ids. No enumeration path.
- **Ops shell:** serves only the public-by-design Google client id and browser Maps key.
- **Ops CSRF:** `ch_ops` is `SameSite=Lax`, and `/admin/quote/*` writes additionally carry a
  `Sec-Fetch-Site` + Origin gate.

## Never audited — these are NOT on the list
Injection (SQL / path traversal / prototype pollution), the email path as a spam relay, dependency
hygiene, security headers, and the Ride Board charge path.

---

## H1 — Payment adapter can silently fall back to a fake with a public signing key — FIXED (`f1fa8d9`)

**Severity: Critical if the env is misconfigured; today it is a go-live blocker.**

**Fixed:** `config.ts` now refuses to boot in production unless both PayHere values are set, and
`FakePaymentAdapter` throws if constructed in production. Regression tests cover both.

- `api/src/server.ts:35-43` — the real PayHere adapter is used only when both `PAYHERE_MERCHANT_ID`
  and `PAYHERE_MERCHANT_SECRET` are set; otherwise the app constructs `FakePaymentAdapter()`.
- `api/src/app.ts:87` — `const adapter = deps.adapter ?? new FakePaymentAdapter();`
- `api/src/adapters/payments.ts:55` — `const DEFAULT_SECRET = process.env.FAKE_PAYMENT_SECRET ?? 'fake-secret';`

If either PayHere variable is blank, missing or typo'd, the payment seam degrades to a fake whose
webhook signing key is the literal string `'fake-secret'` — published in this repo. `FAKE_PAYMENT_SECRET`
is not in the `Env` schema in `config.ts` and is not on the go-live checklist, so it would never have
been set.

Exploit, entirely unauthenticated:
1. `POST /bookings/single` → returns `id`, `reference`, `total`.
2. `POST /bookings/{id}/checkout` → returns `orderId`, `amount`, `currency`; booking → `payment_pending`.
3. `POST /webhooks/payments` with a body signed by `HMAC_SHA256('fake-secret', "<orderId>|<amount>|USD|succeeded|<txn>")`.
4. Signature validates, amounts reconcile, booking → `paid`, confirmation email sent, concierge task filed.

Result: a fully paid, ops-queued booking for $0.

Note the contrast — `config.ts:80-101` *does* fail closed in production for `OPS_SESSION_SECRET`,
`BOOKING_LINK_SECRET` and `CUSTOMER_SESSION_SECRET`. The payment adapter is the one money-critical
secret with no such guard.

**Fix:** in `buildConfig`, throw at boot when `NODE_ENV === 'production'` and the PayHere credentials are
unset, matching the three existing guards. Additionally make `FakePaymentAdapter` refuse to construct in
production, and drop the `?? 'fake-secret'` default so the variable must be supplied explicitly.

## M1 — An unpriceable booking is charged a $40 placeholder and auto-confirmed

`api/src/routes/bookings.ts:53-68` (`resolveTotals`), line 66:
`const total = Math.max(quotedTotal ?? 0, placeholderTotal);`
`api/src/services/pricing.ts:131-146` — the single-transfer placeholder is `$40` flat, regardless of route.

`priceSingle` returns `unpriced` whenever `maps.distance(from,to)` is null (`pricing.ts:42`), which happens
when Google fails and the name isn't in the offline `COORDS` table — including the `MAX_SL_ROAD_KM = 900`
rejection. `from`/`to` are free text (`z.string().min(1)`).

So: submit a transfer whose endpoints can't be routed, omit `quotedTotal`, and the booking is created at
$40, charged at $40, marked paid, and sent the standard confirmation email — for a trip that really prices
at $150+. Because `flagPricing` compares only against the client's own `quotedTotal`, omitting it means no
mismatch signal fires either.

Mitigating (why this is Medium): every such booking raises a `follow_up` concierge task reading
"unpriced booking — distance unresolved, verify price", and ops contacts every customer. But the charge,
the paid transition and the confirmation all happen before a human sees it.

**Fix:** make an unpriced booking non-chargeable — either 422 the create, or persist it in a state that
`POST /:id/checkout` rejects (the status gate at `bookings.ts:417` is already the right shape).

## M2 — `POST /quote/lock` sits outside the rate limiter — FIXED (`f1fa8d9`)

`api/src/app.ts:136` — `app.use('/quote', rateLimit(rl));`

Hono matches a bare middleware path exactly, so `/quote/lock` is uncovered. The repo already knows this
pattern: `app.ts:147-148` uses `'/admin/quote/*'` and `security.test.ts:116-123` pins the behaviour.

`/quote/lock` (`routes/quote.ts:57-85`) is unauthenticated and writes a `quotes` row per call with a 7-day
lock, and `quoteExpiry.ts` only sweeps `sent` ops quotes — so `channel:'web'` rows accumulate. Unbounded
anonymous row insertion against the database.

**Fixed:** now `app.use('/quote/*', rateLimit(rl))`. A test pins both `/quote/lock` throttling and
that the bare `/quote` did not lose its limit; it was confirmed to fail against the old registration.

## M3 — Chauffeur day count is client-declared, with no feasibility check *(plausible)*

`api/src/services/pricing.ts:69-90` → `api/src/quote/chauffeur.ts:26` — `days` is derived from the client's
`dates[]`. A 7-leg chauffeur trip submitted with every date set to the same day prices as 1 day, saving
roughly $186 of day rate while the server-resolved km charge stays. `validateRide` checks shape only.

Counter-argument I could not fully dismiss: the day count *is* the customer's declared itinerary and the
collapsed dates are visible to ops before dispatch. Treat as hardening: reject or flag a chauffeur trip
whose declared span cannot absorb its driving hours.

## Low

- **L1** `api/src/adapters/payhere.ts:99` — `md5sig` compared with `!==` rather than `timingSafeEqual`,
  which every other signature check in the codebase uses. Not practically exploitable over HTTPS;
  fix for consistency.
- **L2** `api/src/adapters/payhere.ts:90,96-97` — the webhook's `merchant_id` is hashed but never compared
  to the configured merchant. Not forgeable, but the server will process a notification claiming any
  merchant. One-line fix; no test covers merchant identity.
- **L3** `api/src/routes/bookings.ts:411-459` — `POST /bookings/:id/checkout` is unauthenticated and echoes
  `first_name/last_name/email/phone`. Ids are UUIDs so not enumerable, but `GET /bookings/view` is
  token-gated for exactly this reason, which makes checkout the inconsistent one.
- **L4** `api/src/routes/webhooks.ts:64-97` — read-then-write race on settlement. Concurrent PayHere
  retries both pass the idempotency check; the second is correctly rejected by the compare-and-set in
  `postgresBookingRepo.ts:246-256`, but surfaces as a 500 and a founder alert. Make `markSucceeded`
  conditional (`WHERE status <> 'succeeded'`) and treat zero rows as already-settled.
- **L5** `api/src/services/scheduler.ts:99-124` — a shared booking swept after 24h in `payment_pending`
  can still be paid afterwards: money in, no booking. Already alerted as `paid_in_unexpected_status`;
  recorded so it isn't rediscovered.

---

## Verified safe — do not re-audit

- **Webhook signature.** The `md5sig` algorithm and field order are correct (`payhere.ts:96-97`) and pinned
  by an independent literal in `payhere.test.ts:56-71`. `status_code` is inside the signature and strictly
  validated, so the "signed as failed, flipped to success" tamper is rejected (tested).
- **The no-delimiter re-split attack.** Because the signed string concatenates five attacker-supplied
  fields without separators, a captured notification can in principle be re-split. It is *not* exploitable:
  any re-split keeping `status_code === '2'` and `currency === 'USD'` also fixes the order/amount boundary,
  and anything else fails `findByOrderId` or the amount/currency reconciliation. **This is load-bearing on
  the currency check at `webhooks.ts:50` — do not weaken it.**
- **Length extension.** The checkout `hash` returned to the browser is an oracle for `MD5(X ‖ S)`, but it
  cannot yield a valid `md5sig`: the notify string must end in `status_code = "2"` while the checkout
  string always ends in the hard-coded `"USD"`.
- **Amount tampering.** `/checkout` accepts no request body at all; `order_id`, `amount` and `currency` are
  all server-derived from `booking.amountDueNow`, and the webhook reconciles against the stored values.
- **Secrets.** No merchant secret, signature or API key is reachable client-side. The only key in the front
  end is the referrer-restricted browser Maps key, documented as public.
- **Replay / refund flip.** A replayed success short-circuits; a non-success after settlement alerts and
  changes nothing. There is no `refunded` payment state and no path back to `paid`.
- **Refunds.** All admin money actions require a human session with `payments:act`; `x-admin-key` resolves
  to `system`, which lacks it. No amount is accepted and no gateway refund is called, so
  "partial refund > paid" is unreachable. There is no customer-facing refund endpoint.
- **Booking state machine.** `domain/status.ts` is a forward-only allow-list with a compare-and-set in the
  repo. `paid` is written only by the webhook; `confirmed` only from `paid`. No endpoint accepts an
  arbitrary status.
- **Mass assignment.** No `{...req.body}` reaches a booking or payment write. `PATCH /admin/quote/:id`
  cannot touch `totalCents`; the maker-checker gate is intact.
- **Rate lock.** `/quote/lock` stores the server-side `RATE_CARD` constant, never a client value, and
  `bookingRateCard` additionally restricts to `channel === 'web'`. Ops quote→booking prices from the
  stored server-computed total and requires `channel === 'ops'`, so a customer's locked row can never be
  converted.
- **Money arithmetic.** Integer cents end to end; `sell()` uses integer math deliberately. `finishPrice`
  rejects non-integer/negative, and `quotedTotal` is `z.number().int().min(100).max(100_000_000)`, so
  `NaN`/`Infinity`/negatives cannot reach a total.
- **Idempotency.** Booking creation keys on `Idempotency-Key` with an in-memory guard plus a DB unique
  constraint; `payments.orderId` and `idempotencyKey` are both UNIQUE; `/checkout` 409s if already settled.
- **Auth basics.** Ops cookie is `httpOnly; secure; SameSite=Lax`; `x-admin-key` uses `timingSafeEqual` and
  fails closed on an empty key; `dev-login` refuses anything but development/test; `/admin/quote/*`
  mutations carry a `Sec-Fetch-Site` + Origin CSRF gate; `/dev/emails` is not mounted in production.

## Still to review

- **Pricing and distance manipulation** — the 0 km / Maps-failure fallback, Sri Lanka bounding-box
  validation, negative and overflow inputs, multi-stop caps, server-side enforcement of the Wed/Sat
  shared-service rule and vehicle capacity, and shared-seat oversell races. (M1 above touches the
  fallback but is not a complete pass.)
- **Access control and injection** — IDOR on customer booking lookup, per-endpoint ops capability checks,
  stored XSS from customer-supplied fields into an authenticated founder's ops screen, CORS, and rate
  limiting on the unauthenticated write paths.

---

# Price & distance manipulation pass (run 2026-07-25, after the limit reset)

Every CONFIRMED finding below was demonstrated against the running app, not inferred.

## Fixed (`ebf1e54`)

- **An invalid request became a cheap chargeable booking.** `runEngine` turned *every* engine
  rejection into an "unpriced" outcome, and unpriced bookings fall through to a flat placeholder
  that `/checkout` will charge. `bags: 100` (or `adults: 100`) turned a **$125.00 transfer into a
  $40.00 booking** plus a confirmation email — no bad place names, one integer field. The booking
  path now returns 422 for the same error set `/quote` already rejected. Genuine pricing hiccups
  still degrade to the placeholder; that distinction is the fix.
- **`nights: []` collapsed the chauffeur floor.** The placeholder was `(sum(nights)+1) × $55` and
  `nights` is a client array unrelated to `stops`, so a 6-stop trip pricing at **$789.00 floored at
  $55.00**. The floor can no longer be fewer days than the trip has legs.
- **Shared seats could be oversold ~7×.** Inventory is keyed on `(corridor, date, time)` and
  `holdSeats` find-or-creates that row with a *full* van, so an unrecognised time minted another 12
  seats: `'07:30'`, then `'7:30'`, `'07:30 '`, `'07:31'`, `'lunchtime'`, `'99:99'` — **84 seats sold
  on a 12-seat van**, each at the correct price. Departure times now live in the corridor catalogue
  (mirroring `transfers-data.js`, as service days and seat price already do) and an unpublished time
  is refused. The atomic hold was never the weakness — the key was.
- **`stops` was unbounded.** Each leg is a billed Distance Matrix element resolved sequentially; a
  60-stop request was accepted and 5000 stops fired 4999 lookups from a single call — a Maps-spend
  and latency amplifier. Capped at 12, matching the ops tool's existing 8-stop cap in spirit.

## Open — needs an owner decision

- **H2: a Google failure silently reprices known routes ~39% low.** `maps.distance()` falls back to
  `haversine × 1.35` whenever Google errors, times out, hits `OVER_QUERY_LIMIT`, is denied, or
  returns `ZERO_RESULTS`. Colombo City → Ella: **Google 292 km → $123.50; offline 179 km → $78.00**,
  with no warning, no line item and no ops flag. (CMB → Galle goes the other way, +22%.) This is a
  straight revenue leak on any Maps outage, key rotation slip or billing lapse. The fix is a
  business call: either refuse to price and route to the ops queue when Google fails, or replace the
  crow-flies estimate with stored real road km for the known pairs — and in both cases flag the
  booking. **Recommended before go-live.**
- **M3: chauffeur day count is client-declared.** `days` is honoured whenever `dates` is incomplete
  (fewer entries than legs, or any non-ISO), and it drives both the day rate and the idle-day
  minimum km: the same itinerary priced **$789.00 at `days: 9` and $329.00 at `days: 1`**. The ops
  path already requires a date on every leg. Enforcing that publicly would change what the customer
  planner allows (flexible dates are deliberate), so it needs your call.
- **M4: `Idempotency-Key` is a global unauthenticated namespace.** A key is looked up and the stored
  booking returned in full *before* any ownership check, so a victim reusing an attacker's key
  receives the **attacker's booking, including their customer details**. The site derives the key
  from a 32-bit hash of the request body, so collisions are reachable accidentally too. Fix: scope
  the key to the customer email or session, and 409 when a stored key's body doesn't match.
- **L1** client-supplied `distanceKm` on `/quote/lock` persists into founder analytics (`channel=web`
  rows feed the Quoted/Avg-$ tiles). **L2** public chauffeur quotes carry no `pax`, so a car quoted
  for 10 people shows car pricing (booking-time recompute corrects it — a shown-vs-charged
  mismatch, not an undercharge). **L3** `distanceKm: 1e15` yields a total beyond `MAX_SAFE_INTEGER`;
  bound it by `MAX_SL_ROAD_KM`. **L4** rate-lock replays a stored rate card with no integrity check
  — no client path writes that field today, so this is defence-in-depth. **L5** no Sri Lanka
  bounding-box check on `from`/`to`.

## Verified safe in this pass — do not re-audit

`quotedTotal` can never undercut a priced booking; bookings never accept a client distance; shared
seat price is DB-authoritative; Wed/Sat service days are enforced server-side before inventory is
touched; seat holds are genuinely race-safe (Postgres guarded UPDATE / no-await check-and-increment);
vehicle capacity is enforced and can only be upgraded; add-ons are an enum with no client quantity or
price; `customPerKmCents` is not client-reachable; the rate lock binds the *card* not the price and
expiry is enforced at redemption; negative/zero/fractional/string pax and negative distances are all
rejected; `memoizeDistance` does not double-bill Google.

## Not covered

The **access-control pass** (IDOR on booking lookup, per-endpoint ops capability checks, stored XSS
from customer fields into an authenticated ops session, CORS, rate limiting) has still never run.
Unreviewed is not the same as clean. The Ride Board charge path was also only skimmed.

---

# Access-control & injection pass (run 2026-07-25, by hand)

Run in the main session rather than by agent, to keep the cost down. Three threads, each stopped
once answered.

## Fixed (`fa7de9b`) — CSRF on the Ride Board, demonstrated

`api/src/routes/rideBoard.ts` — a bodyless cross-site POST to `/board/:code/scratch` removed a
signed-in traveller from their ride list. Before: `["Victim"]`. After: `[]`. Status 200.

The `ch_cust` cookie is deliberately `SameSite=None` (board.html on Pages calls the API on Render),
so unlike the ops cookie it *does* ride cross-site requests. `setCustomerCookie` reasons that CSRF is
covered because the write endpoints only accept `application/json`, which forces a CORS preflight.
That holds for routes which parse a body — but `/scratch` reads no body at all, so a cross-site POST
with no content-type is a **simple request**: no preflight, cookie attached, side effect done. The
attacker cannot read the response, which does not matter: the traveller is already off the list.

Fixed with an Origin allow-list guard as router middleware. The ops CSRF guard could not be reused —
it requires `Sec-Fetch-Site: same-origin`, which is exactly wrong for a board that is cross-origin by
design. Verified `evil.example` → 403 with the traveller still listed, own origin → 200.

## Verified safe in this pass — do not re-audit

- **Stored XSS into the authenticated ops UI.** `ops-ui.html` has a consistent `esc()` discipline;
  every customer-controlled field sampled (name, email, whatsapp, notes) is escaped, and the
  analytics bar labels escape too. The only unescaped interpolations are a plain-text WhatsApp
  reminder copied to the clipboard and a search-filter string comparison — neither is an HTML sink.
- **Ops capability checks.** Every route in `ops.ts` carries a `requireCap` except `/login`,
  `/dev-login`, `/logout`. `opsAnalytics.ts` and `internalQuote.ts` gate at the router level with
  `r.use('*', …)` (`analytics:view` / `quote:manage`), with the bare `/admin/quote` redirect
  deliberately exempt. `admin.ts` guards every route inline. No verb-level gap found.
- **Customer booking lookup (IDOR).** `lib/bookingToken.ts` is HMAC-SHA256 over the booking id with
  a dedicated secret (never cross-replayable with the ops session), length-checked and compared with
  `timingSafeEqual`. Booking ids are UUIDs. No enumeration path.
- **Ops shell.** `opsUi.ts` serves the HTML with only `GOOGLE_CLIENT_ID` and the browser Maps key
  templated in — both public-by-design browser values. Data comes from the guarded APIs.
- **Ops CSRF.** The `ch_ops` cookie is `SameSite=Lax`, which by itself blocks cross-site POST, and
  `/admin/quote/*` mutations additionally carry a `Sec-Fetch-Site` + Origin gate.

## Still not covered

Injection (SQL/path traversal/prototype pollution), the email path as a spam relay, dependency
hygiene, and security headers were not reached in this pass. The Ride Board charge path remains
un-audited (it runs behind fakes with $0 preapprovals).
