# Security review — 2026-07-25 (partial)

Review of `origin/main` @ `7047afb`, focused on payment integrity, pricing/distance manipulation and
access control.

**Completeness:** the **payment-integrity** pass finished and is below. The **pricing/distance** and
**access-control** passes were cut short by an API session limit before producing findings — treat those
two areas as **not yet reviewed**. Nothing below has been fixed yet.

Findings were read from source; `api/node_modules` was absent so the test suite could not be executed.

---

## H1 — Payment adapter can silently fall back to a fake with a public signing key

**Severity: Critical if the env is misconfigured; today it is a go-live blocker.**

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

## M2 — `POST /quote/lock` sits outside the rate limiter

`api/src/app.ts:136` — `app.use('/quote', rateLimit(rl));`

Hono matches a bare middleware path exactly, so `/quote/lock` is uncovered. The repo already knows this
pattern: `app.ts:147-148` uses `'/admin/quote/*'` and `security.test.ts:116-123` pins the behaviour.

`/quote/lock` (`routes/quote.ts:57-85`) is unauthenticated and writes a `quotes` row per call with a 7-day
lock, and `quoteExpiry.ts` only sweeps `sent` ops quotes — so `channel:'web'` rows accumulate. Unbounded
anonymous row insertion against the database.

**Fix:** `app.use('/quote/*', rateLimit(rl))`.

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
