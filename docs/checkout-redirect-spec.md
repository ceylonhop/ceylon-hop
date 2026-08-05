# Replacing the PayHere iframe checkout with a top-level redirect

**Status:** **BUILT** — server and client, on branch `spec/redirect-checkout`. Not merged, not shipped.
**Both §2 prerequisites are now resolved** (§2.1 answered from the dashboard, §2.2 downgraded —
see the owner note in §1.2, which retracts this spec's original reading of the pending payments).
What remains before shipping is §7 verification: sandbox, the decline-redirect question, and real
devices.
**Written:** 2026-08-05. **Trigger:** a real customer could not pay quote CH-XKZL3 on 2026-08-05.
**Scope:** `pay.html` (WhatsApp pay links) only. `booking.html` runs the same SDK and has the same
defect — see §10; it is deliberately NOT in this spec's scope.

Today both customer payment surfaces call `payhere.startPayment()`, which runs PayHere's checkout
inside a **third-party iframe** injected into our page. This spec replaces that with the **HTML form
POST redirect** PayHere documents as its primary Checkout API integration: the customer leaves our
origin for `https://www.payhere.lk/pay/checkout`, pays there, and is redirected back.

Nothing in this spec changes what we charge, how we price, or how a payment is confirmed. The
`notify_url` webhook remains the **only** source of truth for settlement, before and after.

---

## 1. The evidence

Everything in this section was read on 2026-08-05. DB queries were run against the production
Supabase database in `default_transaction_read_only=on` sessions.

### 1.1 The reported failure — CH-XKZL3

Customer reported at 08:40 (their time): *"I tried to make payment but seems like the 'pay' button
after filling out my details does not work and that page keeps loading."*

```
reference | booking_status  | booking_created_slt        | pay_status | amount | gateway_payment_id | settled_at
CH-XKZL3  | payment_pending | 2026-08-05 18:02:36.106847 | pending    |   5200 | (null)             | (null)
                              payment row created 18:02:38.473703
```

`payment_events` for this payment: **0 rows.**
`alert_log` client-error beacons on 2026-08-05: **none.**

What that proves, in order:

1. `POST /quotes/pay/start` **succeeded** — a booking row exists.
2. `POST /bookings/:id/checkout` **succeeded** — a payment row exists with the correct amount
   ($52.00 USD), created 2 seconds after the booking. Our server built and signed the PayHere
   fields correctly.
3. The PayHere iframe therefore **opened on the customer's device** — `pay.html` calls
   `payhere.startPayment()` only after `/checkout` returns a `payhere.lk` URL.
4. **PayHere never processed anything.** No `payment_events` row means no `notify_url` callback of
   any status. We know from CH-4KU9Z (a real decline, status `-2`, 2026-08-02) that genuine declines
   *do* produce a webhook. So this was not a decline: the payment attempt died before PayHere
   reached a verdict.
5. **Our page never saw an error.** No client-error beacon fired, so no JS exception occurred on
   our origin and `payhere.onError` never fired. The failure was entirely inside the cross-origin
   iframe, where our page has no visibility — which is exactly what the customer described as
   "keeps loading".

`terms_accepted_at` on this booking is 18:26:11, ~24 minutes after creation: the owner's own test of
the same link, which correctly reused the booking and payment row via the idempotency key.

### 1.2 How common is it? Not established — and the raw counts MISLEAD

Payments created in the last 14 days, by status:

```
succeeded |  3
failed    |  1
pending   |  8
```

The eight `pending` rows, oldest first: CH-HL3P6 (2026-07-23, booking now cancelled), CH-4XBFW and
CH-79HNC (2026-07-31, both cancelled), CH-MNSQD (2026-08-01, $50.00), CH-W6RHF (2026-08-01, $64.50),
CH-JTHDE (2026-08-02, $749.00), CH-B44VY (2026-08-04, $59.00), CH-XKZL3 (2026-08-05, $52.00).

> **Owner, 2026-08-05: all of these except CH-XKZL3 are the owner's own testing.** They are not
> stranded customers, they need no follow-up, and they are **not evidence of a failure rate.** An
> earlier draft of this spec read them as a systemic bleed; that reading was wrong and is retracted
> here rather than quietly deleted, because the same query will look just as alarming next time.

**Anyone querying this table later needs to know: `pending` rows are dominated by owner testing, and
the DB cannot tell a test from a customer.** `bookings.channel` does not separate them either — the
owner's pay-link tests are `channel = 'whatsapp'`, exactly like a real pay link.

So the honest position on scale: **one confirmed real-customer failure (CH-XKZL3), and no measured
failure rate at all.** The case for this change does not rest on volume — it rests on §1.4 and §1.5:
the iframe integration is structurally unable to report its own failures, and the redirect is the
integration PayHere documents as primary. That argument was never a volume argument, and it is
unweakened by the counts being smaller than they looked.

It also means **do not treat this as an emergency.** Build it properly, verify it per §7, ship it
when it is right.

### 1.3 One unexplained beacon

```
kind         | dedupe_key   | count | last_sent_at (SLT)
client_error | 2a926f877aff |     2 | 2026-08-04 07:07:11.312
```

Eight minutes before CH-B44VY's payment row was created (07:15:48). **That correlation is now weak:
CH-B44VY was owner testing (§1.2), so this beacon plausibly belongs to the owner's own device rather
than to a failing customer.** `alert_log` stores only the dedupe hash; the full event is in Sentry.
**Unread.** Still worth opening — it costs a minute and either names a failing device or rules
itself out — but it is no longer evidence of anything on its own.

### 1.4 What the SDK actually does

`https://www.payhere.lk/lib/payhere.js` (fetched 2026-08-05, 11,557 bytes, obfuscated) was
deobfuscated for this spec. `payhere.startPayment(params)`:

1. Appends `<div id="ph-container">` to `document.body`, containing
   `<iframe id="ph-iframe" class="ph-checkout-frame">` over a backdrop.
2. Sets `params.iframe = true` and sends a form-urlencoded `XMLHttpRequest` **POST** to
   `https://www.payhere.lk/pay/checkoutJ` (live) or `https://sandbox.payhere.lk/pay/checkoutJ`.
3. On success, sets the iframe `src` to the returned URL — **the entire card form, and any 3-D
   Secure bank challenge, renders inside that cross-origin iframe.**
4. Assigns `window.onmessage` and switches on `postMessage` type: `1` stores an order key,
   `2` → `onCompleted`, `3` → change iframe `src`, `4` → `onDismissed`.

Three consequences follow directly from that code, and each independently explains a spinner that
never resolves:

- **The card form and the 3-D Secure challenge are third-party framed content.** Issuer ACS pages
  commonly send `X-Frame-Options: DENY` or a frame-ancestors CSP; when they do, the frame renders
  nothing and no callback fires.
- **It depends on third-party cookie/storage access.** Safari and every iOS browser partition or
  block third-party storage by default; Chrome is phasing it out. A pay link sent over WhatsApp is
  usually opened in an in-app webview, the least permissive environment of all.
- **Failures inside the frame are silent to us.** `onError` fires only for errors PayHere's own
  wrapper raises (its three validation checks and the XHR to `checkoutJ`). Anything that goes wrong
  *after* the iframe loads reaches none of the three callbacks — no error, no dismissal, no
  completion. That is precisely the CH-XKZL3 signature in §1.1: server-side success, zero webhook,
  zero beacon.

`payhere.js` also assigns `window.onmessage` directly (clobbering any existing handler) and the
deobfuscated source shows **no origin check** on received messages. Not the cause of this bug; worth
recording as a second reason to stop loading their script on our payment page.

### 1.5 What PayHere documents

Source: [Checkout API](https://support.payhere.lk/api-&-mobile-sdk/checkout-api), read 2026-08-05
(the page 403s to `curl` and to WebFetch — it is behind Cloudflare; open it in a browser). Docs last
updated 22 Dec 2025.

> "It offers a simple HTML Form based POST API to initiate a payment request and redirect your
> customer to PayHere Payment Gateway to securely process the payment."

The redirect — not the iframe — is the integration PayHere documents first and describes as the way
the API is meant to be used. Action URLs: `https://www.payhere.lk/pay/checkout` (live),
`https://sandbox.payhere.lk/pay/checkout` (sandbox).

Required POST parameters: `merchant_id`, `return_url`, `cancel_url`, `notify_url`, `first_name`,
`last_name`, `email`, `phone`, `address`, `city`, `country`, `order_id`, `items`, `currency`,
`amount`, `hash`. **We already build and sign every one of these** — `PayHerePaymentAdapter.createCheckout`
returns exactly this set, with the same `hash` formula the docs specify. The redirect needs no new
server-side field construction.

Two documented facts that shape the entire design:

> "No payment status parameters are passed to the return_url when redirecting the customer back to
> your website. You need to update your database upon fetching payment status by your script on
> notify_url & then show the payment status to your customer in the page on return_url by fetching
> the status from your database."

This is the design we already have — the webhook is truth, and the pay page already polls
`/quotes/pay/view` in `awaitSettle()`. The redirect fits our existing architecture without changing
where truth lives.

> "Merchant Secret is specific to your integrating domain/app. Therefore, you need to add your new
> domains/apps & get a new Merchant Secret every time you're integrating PayHere on a new domain/app."

See §2.1 — this is a blocker.

Also documented and currently unused: `custom_1` / `custom_2` (echoed back in the notify payload),
and itemised `item_name_N` / `amount_N` / `quantity_N` parameters. Both are relevant later (§9).

---

## 2. Prerequisites — none of these are code

### 2.1 ~~Confirm which domain(s) the merchant secret is registered for~~ RESOLVED

**Answered 2026-08-05 from the PayHere dashboard (Integrations).** Merchant `243025` has exactly
**one** registration:

```
TYPE     DOMAIN/APP      GATEWAY CUSTOMIZATION    STATUS
web      ceylonhop.com   Ceylon Hop (PVT) LTD     Active
```

`pay.ceylonhop.com` is **not** separately registered, and does not need to be. PayHere's own
instruction is to "Enter your **top level** domain", and the arrangement is already proven in
production: the live pay links have been served from `pay.ceylonhop.com` and signed with this
secret since 2026-08-02, and real USD charges have settled through them.

**Do NOT add `pay.ceylonhop.com` as a second domain.** Each registration issues its OWN merchant
secret, and the server holds one. A second secret is how you get a `hash` signed with the wrong
key — which fails identically to every other credentials mistake, and is the exact confusion this
section existed to prevent.

Nothing about the redirect changes this: the form is served from the same origin, with the same
merchant id, secret and hash as the iframe flow. Only `return_url` moves, and no documented
domain validation applies to it.

### 2.2 Confirm CH-XKZL3 in the PayHere dashboard

**Downgraded from a blocker (owner, 2026-08-05):** the other pending rows were owner testing, so
there is no population to survey — see §1.2. What remains is the single real failure.

**Action:** look up CH-XKZL3 in the PayHere merchant dashboard. Either an attempt was recorded and
stalled (which pins the death point inside the iframe precisely), or nothing arrived at all (which
says the frame never reached PayHere). Both corroborate §1.4; they differ on which of its three
mechanisms applied.

**Why it is no longer a blocker:** the fix does not depend on the answer. The redirect removes the
entire class either way, and §1.1's evidence for CH-XKZL3 stands on its own. Worth doing because it
is cheap and it is the only real data point that exists.

### 2.3 Read the Sentry event behind `2a926f877aff`

Cheap, and may identify the failing device class directly (§1.3). Not a blocker: if Sentry has
rotated it out, proceed without it.

---

## 3. What changes

```
BEFORE  pay.html ──fetch──> /quotes/pay/start ──fetch──> /bookings/:id/checkout
                                                              │ returns {checkoutUrl, fields}
                                                              ▼
                                            payhere.startPayment() → cross-origin IFRAME
                                                              ▼
                                                    (failures invisible here)

AFTER   pay.html ──fetch──> /quotes/pay/start ──fetch──> /bookings/:id/checkout
                                                              │ returns {checkoutUrl, fields}
                                                              ▼
                                        auto-submitting <form method="POST"> → TOP-LEVEL navigation
                                                              ▼
                                              payhere.lk hosted checkout (first-party there)
                                                              ▼
                                          return_url / cancel_url → back to pay.html
                                                              ▼
                                        poll /quotes/pay/view (webhook = truth, unchanged)
```

The server's checkout contract is unchanged. The client stops rendering the gateway and starts
navigating to it.

---

## 4. Design decisions

**D1 — Top-level form POST, not `window.location`.** PayHere's checkout requires POST with ~16
fields. Build a `<form method="POST" action="{checkoutUrl}">` with one hidden input per entry of
`checkout.fields`, append to `document.body`, call `form.submit()`. Field values come from the
server verbatim; the client must never reorder, rename, add to, or recompute them — the `hash`
covers `merchant_id + order_id + amount + currency` and is generated server-side (the docs are
explicit that it must not be generated client-side, and it already is not).

**D2 — Delete `payhere.js` from `pay.html`.** With D1 there is no SDK call left. Removing the
`<script src="https://www.payhere.lk/lib/payhere.js">` tag also removes: a third-party script on our
payment page, the ad-blocker failure mode the current code apologises for in its own error copy, and
the unchecked `window.onmessage` handler from §1.4.

**D3 — `return_url` and `cancel_url` must become per-checkout.** They are currently fixed at adapter
construction (`server.ts:52-53`) and both point at `${APP_BASE_URL}/booking.html` — the *website*
checkout's page, which is the wrong destination for a pay-link customer and today lands them on a
booking wizard with no context. `CreateCheckoutArgs` gains optional `returnUrl` / `cancelUrl`;
`PayHerePaymentAdapter.createCheckout` prefers them and falls back to `this.opts.*` so the website
flow and every existing test keep their current behaviour unchanged.

**D4 — The return journey carries a purpose-scoped token, never the pay token.** `return_url` is
sent to PayHere, stored in their systems, and travels through a redirect chain. The quote pay token
`t` is a bearer credential for the whole quote, so it must not be put there. Mint a new
`purpose: 'pay-return'` token over `bookingId`, signed with the same `linkSecret`, following the
existing packed-token pattern in `api/src/lib/bookingToken.ts` (which already keeps `checkout`,
`quote-pay` and booking purposes disjoint so none can be replayed as another). It authorises exactly
one thing: reading the settlement status of that booking.

**D5 — On return, poll; never trust the redirect.** PayHere documents that no status parameters are
passed to `return_url` (§1.5). The returning page therefore renders the existing "Confirming your
payment…" state and polls until the webhook lands — the `awaitSettle()` behaviour that exists today,
entered from a page load instead of from an SDK callback.

**D6 — A decline must not read as an infinite wait.** `awaitSettle()` today polls 30 times at 2s and
then shows "Payment received?" — correct for a slow webhook, wrong for a card that was refused. The
returning page must distinguish three outcomes: `paid` → the existing keepsake; **a payment row that
reached a terminal failed/cancelled status** → the details form restored, with the existing
`DECLINE_HELP` steps; still pending after the poll budget → the existing "taking longer than usual"
copy. This requires `/quotes/pay/view` to be able to say "this attempt failed", which it cannot
today — it returns `payable` for both "not started" and "attempt failed". **This is the largest
piece of new work in the spec and must not be hand-waved:** without it the redirect makes the
decline experience worse than the iframe's, which at least fired `onError`.

**D7 — The typed form values must survive the round trip.** `typed` is a JS variable and dies on
navigation. Persist it to `sessionStorage` (per-origin, per-tab, survives navigating away and back)
under a key scoped to the pay token, restore it in `renderDetails()`, and clear it when the booking
reaches `paid`. Without this, every declined or cancelled customer re-types name, email, phone and
full billing address — a regression against today's behaviour, on the screen where they are already
frustrated. **Do not store card data — none of it ever reaches our origin, and none of it may start
now.**

**D8 — Both fetches get a timeout.** `/start` and `/checkout` have none. On a stalled API the button
sits at "Opening secure payment…" forever with no retry — an *alternate* silent-hang path that the
redirect does not fix. Worth doing on its own merits, not as a theory about any particular payment.
Use `AbortSignal.timeout()` (the codebase already uses it in `payhere.ts`) and surface the existing
"no charge was made" error so the customer can retry.

**D9 — Analytics continuity.** `web-tests/unit/payment-funnel-analytics.test.js` exists and the page
loads GTM. Whatever funnel event fires today at the moment of `startPayment` must fire at the moment
of form submit, and the return leg must not double-count a purchase. Read that test before touching
the page; do not invent new event names.

---

## 5. Server changes

All in `api/`. Each is additive; none changes an existing call site's behaviour.

1. **`adapters/payments.ts`** — add optional `returnUrl?: string` and `cancelUrl?: string` to
   `CreateCheckoutArgs`.
2. **`adapters/payhere.ts`** — in `createCheckout`, use `args.returnUrl ?? this.opts.returnUrl` and
   the same for cancel. **Do not touch the `hash` computation or the field set** — the hash covers
   `merchant_id + order_id + amount + currency` only, so these URLs are outside it, and §1.1 proves
   the current field construction is already correct in production.
3. **`lib/bookingToken.ts`** — add `signPayReturnToken` / `verifyPayReturnToken` with a disjoint
   `purpose` byte, mirroring the existing packed format and its tests.
4. **`routes/bookings.ts`** (`POST /:id/checkout`) — accept an optional JSON body naming the return
   destination for this checkout, and pass `returnUrl`/`cancelUrl` through. **The client must not be
   able to choose an arbitrary destination:** the server builds the URL from its own configured base
   (`PAY_BASE_URL || APP_BASE_URL`) plus the token it mints, and takes at most a flag from the client
   saying "this is a pay-link checkout". An open redirect on a payment return URL is a phishing
   primitive; the client sends intent, never a URL.
5. **`routes/quotePay.ts`** (`GET /quotes/pay/view`) — extend the state machine for D6 so a terminal
   failed/cancelled payment attempt is distinguishable from "not yet attempted". Preserve the
   existing contract exactly: `paid`, `revised`, `payable`, `unavailable` keep their current meanings
   and the dead-end states keep returning a bare `{state}` with no quote detail. Adding a field is
   safe; renaming or repurposing one is not — `pay-page.spec.js`, `pay-link-chain.spec.js` and
   `quotePay.test.ts` all assert against this.

**Explicitly unchanged:** the webhook handler, `md5sig` verification, the settlement path, the
idempotency keys (`checkout:{bookingId}` and `pay:quote:{id}:r{rev}:s{seq}`), the amount-mismatch
guard, and the `not_chargeable` / `awaiting_price` / `already_paid` refusals. This spec must not
touch money movement.

---

## 6. Client changes — `pay.html`

1. Remove the `payhere.js` script tag (D2).
2. Replace the `payhere.startPayment` block in `startPayment()` with the form POST (D1), keeping every
   existing guard ahead of it: the `checkoutUrl` presence check, the `payhere.lk` test, and the
   dev/fake-gateway honesty path (*"Payments aren't enabled on this environment yet"*) — that last one
   is what stops a non-production environment from looking like it took money.
3. Keep `renderLoading()` as the pre-navigation state, with copy corrected: "Don't close this page"
   is false once we navigate away. It should say we are taking them to PayHere.
4. Persist/restore `typed` via `sessionStorage` (D7).
5. On boot, detect the return leg (the `pay-return` token in the URL) and enter the poll state (D5),
   branching three ways per D6.
6. Add fetch timeouts (D8).
7. Drop the ad-blocker sentence from the error copy — with no SDK to block, it becomes misdirection.

**Do not touch** in this change: the ticket rendering, `linesHtml`/`coverageSentence` (partial pay
links, asserted by `web-tests/unit/pay-page-lines.test.js`), the cancellation-policy switch, the
phone/dial-code widget and its `splitPrefill`/`phoneParts` normalisers, the billing-country follow
behaviour, the dimmed-not-disabled CTA, or the dead-end artwork. Every one of those encodes a
resolved owner decision, and several were bugs fixed within the last week.

---

## 7. Verification — required before this goes near production

**Nothing in this section is optional.** The current defect reached a real customer precisely because
desktop-browser testing passed.

**7.1 Sandbox first.** Point a staging pay link at `sandbox.payhere.lk` and complete a full payment.
Confirm: the redirect arrives, the return leg lands on the right page, and the webhook still settles
the booking.

**7.2 Determine empirically what a DECLINE does.** PayHere documents `return_url` as "when payment is
approved" and `cancel_url` as "when user cancel the payment". **The docs do not say where a *failed*
(status `-2`) payment sends the customer.** Do not guess. Use a sandbox failure card, observe which
URL is hit and with what, and write the answer into this spec before building D6 against an
assumption.

**7.3 Confirm nothing is appended to `return_url`.** The docs say no status parameters are passed.
Verify what actually arrives; the return handler must tolerate both extra query parameters and none.

**7.4 Real devices, not emulation.** At minimum: iOS Safari, the **WhatsApp in-app browser on iOS**,
the **WhatsApp in-app browser on Android**, and Android Chrome. The WhatsApp webviews are the
environment the actual customers use — a pay link is delivered over WhatsApp — and are the specific
environment §1.4 predicts the current code fails in.

**7.5 Automated coverage**, in the existing `web-tests/` harness (Vitest + Playwright, `npm run test:all`):
a test asserting the form POST is built with exactly the server's fields and posts to the server's
`checkoutUrl`; a test that a return-leg load enters the polling state and renders the keepsake once
`/view` reports `paid`; a test that a terminal failed attempt restores the form with decline help and
the typed values; and a test that the pay token never appears in `return_url` (D4).

**7.6 One live end-to-end payment**, smallest possible real amount on production, refunded after —
the refund workflow is already live and in production. Three real USD charges have settled on
merchant `243025`, so a live test is a known-good procedure.

---

## 8. Rollout

The two surfaces are independent; ship `pay.html` alone — it is where the one confirmed failure
happened, and a smaller change is a safer one. (An earlier draft justified the ordering with
whatsapp-channel pending counts; per §1.2 those counts are mostly owner testing and prove nothing.)

There is **no feature flag proposed**, deliberately: a flag would mean maintaining and testing both
the redirect and the iframe path, and the iframe path is the defect. If the redirect fails
verification, it does not ship. If it ships and regresses, revert the PR — deploy is
`main` → staging automatically, then a promote PR to `production`.

Migrations: none. This spec adds no columns and no data model changes.

---

## 9. Deliberately out of scope

- **`booking.html`** — same SDK, same defect (`booking.js:1675`), 3 of 4 website-channel payments
  pending. It needs the same fix, as its own change, once this one is proven. **Recorded here so it
  is not forgotten; not fixed here.**
- **The `items` label** (`bookings.ts:615`, currently `Ceylon Hop Travel - {reference}`). PayHere
  supports itemised `item_name_N` parameters we do not use, and a route-and-date label would be more
  recognisable to the payer than the current string. Worth doing; unrelated to this failure; needs
  its own investigation into where reliable route data lives for a pay-link booking. **Note that
  `items` is not the bank-statement descriptor** — PayHere's Checkout API has no descriptor
  parameter at all, and the statement text can only be changed by asking PayHere.
- **Back-filling the stuck payments.** ~~A commercial decision.~~ **Closed (owner, 2026-08-05): they
  were owner testing. Nobody is to be contacted, and CH-JTHDE's $749 is not a real stranded sale.**
  Only CH-XKZL3 is a real customer, and they are already in conversation on WhatsApp.
- **Any change to pricing, refunds, or the webhook.**

---

## 10. Open questions — answer before building, do not assume

1. **§2.1** — which domains are registered against merchant `243025`, and is `pay.ceylonhop.com`
   among them?
2. **§2.2** — what does the PayHere dashboard show for CH-XKZL3? (No longer a blocker; the other
   pending orders were owner testing and need no investigation.)
3. **§7.2** — where does a *declined* payment redirect the customer?
4. **§7.3** — does PayHere append anything at all to `return_url`?
5. **§1.3** — what does the Sentry event behind `2a926f877aff` say about the device?
6. Does the customer on CH-XKZL3 confirm they opened the link in WhatsApp's in-app browser? One
   message, and it either corroborates §1.4's mechanism or reveals a different one. **The mechanism
   in §1.4 is inferred from PayHere's code plus the absence of a webhook — it is the best-supported
   explanation, not a directly observed one.**
