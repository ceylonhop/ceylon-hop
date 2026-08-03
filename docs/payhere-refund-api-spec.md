# Wiring the PayHere Refund API

**Status:** spec, not built. **Owner decision needed on §1 before any code.**
**Written:** 2026-08-02. **Supersedes:** the "don't wire it yet" note in the refunds workflow —
PH-0013 is cleared and prod PayHere is live (three real USD charges settled on merchant
`243025` on 2026-08-02, via `https://www.payhere.lk/pay/checkout`).

Today an ops agent requests a refund, goes to the PayHere dashboard, issues it by hand, and
pastes the reference back to confirm. This spec replaces the middle step with an API call. It
does **not** replace the manual path — see §7.

Source: [Refund API](https://support.payhere.lk/api-&-mobile-sdk/refund-api), read 2026-08-02
(the docs 403 to `curl`; use a browser). Doc last updated 22 Dec 2025.

---

## 1. Prerequisites — two of these are hard blockers

**These are not code. If they are not in place, the feature cannot work in production and
should not be built yet.**

### 1.1 ⚠️ Static outbound IP, and PayHere must whitelist it

> "To enhance security in the live environment, PayHere enforces an IP-based API key
> whitelisting mechanism for Merchant APIs… please send an email to support@payhere.lk
> including the IP address of the server from which API requests will originate."

Our API runs on Render. **Render does not give every service a stable outbound IP** — it
depends on the instance type. So, in order:

1. Confirm the prod service has static outbound IPs (Render dashboard → service → Connect →
   Outbound). If it does not, this feature is blocked until the service is on a plan that does.
2. Email `support@payhere.lk` with those IPs and wait for confirmation.
3. Only then does a live refund call have any chance of succeeding.

Until (2) is confirmed, every live call returns `status: -2, msg: "Authentication error"` —
which is indistinguishable from a credentials mistake. **Don't debug this in prod; get the
whitelist confirmed in writing first.**

### 1.2 Domain whitelisting

The API key is created with a comma-separated domain whitelist, and live calls are only
accepted from those domains. Register the API host (`pay.ceylonhop.com` / the Render service
domain) when creating the key.

### 1.3 API key with the right permission

PayHere Settings → API Keys → Create API Key. The permission to tick is
**"Automated Charging API"** — yes, that is the one that grants refunds. Copy App ID and App
Secret; they are shown once.

### 1.4 Card-only

The Refund API refunds card payments. Every payment taken so far has been a card (AMEX, VISA),
so this covers current traffic — but it is why §7 keeps the manual path rather than deleting it.

---

## 2. The API, precisely

### 2.1 Token

```
POST https://www.payhere.lk/merchant/v1/oauth/token      (live)
POST https://sandbox.payhere.lk/merchant/v1/oauth/token  (sandbox)

Authorization: Basic base64(app_id + ":" + app_secret)
Content-Type:  application/x-www-form-urlencoded

grant_type=client_credentials
```

```json
{ "access_token": "cb5c47fd-…", "token_type": "bearer", "expires_in": 599, "scope": "SANDBOX" }
```

⚠️ **`expires_in` is 599 seconds — under ten minutes.** This is not a token you fetch at boot
and hold. See §4.1.

### 2.2 Refund

```
POST https://www.payhere.lk/merchant/v1/payment/refund
Authorization: Bearer <access_token>
Content-Type:  application/json

{ "payment_id": "320048263209", "description": "<reason>" }
```

Add `"amount": "100.50"` for a partial refund; omit it for a full one. Send `payment_id` for a
settled payment; `authorization_token` instead is for refunding an *authorization*, which we do
not use.

```json
{ "status": 1, "msg": "Successfully processed the refund", "data": 560034010257 }
```

| `status` | meaning | our handling |
|---|---|---|
| `1` | success | `data` is the refund number → store as `gateway_ref` |
| `0` | error initiating the refund | did **not** happen → safe to retry |
| `-1` | refund failed | did **not** happen → surface `msg`, fall back to manual |
| `-2` | authentication error (domain/IP not allowed) | config problem, never a money problem |

Token errors come back in a *different shape* — `{"error": "invalid_token", …}`, no `status`
field. Parse defensively: a response with no `status` is not a success.

### 2.3 The `payment_id` we send

PayHere's `payment_id` from the settlement notify. We already store it:
`payments.gateway_payment_id`, written from the verified webhook. `CH-MCF8D` holds
`320048263209`.

⚠️ **A failed payment has `payment_id: "0"`** (see `CH-4KU9Z`). Refusing to call the API when
`gateway_payment_id` is absent, `"0"`, or non-numeric is a correctness requirement, not a nicety.

---

## 3. What changes in our model

### 3.1 Migration — new refund statuses

`refunds_status_valid` currently allows `manual_pending | manual_confirmed | cancelled`. Add:

| status | meaning |
|---|---|
| `api_processing` | we are about to call, or have called and don't yet know the outcome |
| `api_confirmed` | `status: 1`, `gateway_ref` = PayHere's refund number |
| `api_failed` | `status: 0/-1`, money definitely did not move; `msg` recorded |

`refunds_confirmation_evidence_valid` must extend so `api_confirmed` carries the same evidence
`manual_confirmed` does (`gateway_ref`, `confirmed_by`, `confirmed_at` all non-null), and so
`api_processing` / `api_failed` carry none.

Two new nullable columns:

- `provider_message text` — PayHere's `msg`, so a failure explains itself
- `api_attempted_at timestamptz` — when we made the call, for the §5 reconciliation

`refunds_provider_gateway_ref_unique` on `(provider, gateway_ref)` already exists and is the
backstop against recording the same PayHere refund twice. Keep it.

### 3.2 Adapter seam

Refunding belongs behind the same seam as `createCheckout` / `parseWebhook`, so the fake adapter
keeps driving tests and no test ever calls PayHere:

```ts
export interface RefundResult {
  outcome: 'succeeded' | 'failed' | 'unknown';
  gatewayRef?: string;      // `data`, on success
  providerMessage?: string; // `msg`, always when present
}

export interface PaymentAdapter {
  // …existing
  refund?(args: {
    gatewayPaymentId: string;
    amountCents: number;   // omit from the body when it equals the captured amount
    currency: string;
    description: string;
  }): Promise<RefundResult>;
}
```

Optional, like `describeWebhookRejection` — an adapter without it means the UI offers manual only.

**`outcome: 'unknown'` is the important one.** It is not an error case; it is the timeout case,
and §5 exists entirely for it.

---

## 4. Implementation notes

### 4.1 Token caching

`expires_in: 599`. Cache in memory per process, refresh when under **60 seconds** remain, and
treat a `401`/`invalid_token` as "refetch once and retry the refund" — but **only for the token
call**. Never blind-retry the refund itself (§5).

In-memory per-instance is correct; tokens are independent and Render may run several instances.
Do not persist the token — it is a bearer credential with a ten-minute life and no reason to
touch the database.

### 4.2 Secrets

Two new env vars, `PAYHERE_APP_ID` and `PAYHERE_APP_SECRET`, alongside the existing merchant
credentials. Mode (`live` / `sandbox`) reuses the adapter's existing `mode`.

⚠️ **Env vars are not promoted.** Per the promote checklist §6, set them on the Render service
*before* the code that reads them ships, or the feature silently does nothing. The reverse trap
applies too: setting them early is harmless but proves nothing.

Fail closed: if the code path is reachable in `live` mode without both vars, refuse to offer the
API route rather than throwing at click time.

### 4.3 Timeouts

Set an explicit timeout (10s) with `AbortController`. An aborted refund is `outcome: 'unknown'`,
never `'failed'` — see §5.

---

## 5. The dangerous case, and the rule that governs it

**A refund request can succeed at PayHere and still not reach us** — timeout, dropped
connection, instance restart mid-call. The money has moved; we have no record.

This is the whole reason the design is what it is:

1. Write `api_processing` with `api_attempted_at` **before** the HTTP call, committed.
2. Make the call.
3. On a definite answer (`status` present), move to `api_confirmed` or `api_failed`.
4. **On any indefinite answer — timeout, abort, network error, unparseable body — leave the row
   in `api_processing` and stop.**

> **Never automatically retry a refund.** There is no idempotency key in this API. A retry
> against an unknown outcome is how you refund a customer twice.

A row in `api_processing` older than a few minutes is an operational alarm, not a bug: someone
must open the PayHere dashboard, look, and resolve it by hand — either confirming with the
reference (reusing the existing manual-confirm endpoint) or marking it failed. The
`(provider, gateway_ref)` unique constraint stops a human resolving the same PayHere refund onto
two rows.

Raise a `critical` alert on any `api_processing` row older than 15 minutes, using the existing
alert seam, deduped by refund id.

---

## 6. Authorization and the UI

Refunds are already gated on `payments:act` (founder + finance). That does not change — but what
the permission *means* does.

**Today a refund physically cannot happen without a human in the PayHere dashboard.** That
second pair of hands is an accidental safety gate, and automating removes it. `payments:act`
becomes the only thing between a misclick and real money leaving the account.

So:

- The confirmation must **name the amount and the payee** — not `window.confirm("Refund $29 in
  full?")`, which is what a browser dialog trains people to dismiss. A typed confirmation for
  refunds over a threshold is worth considering; owner's call.
- The button copy stops being "records the request" and becomes what it now is: money moves.
- Show `api_processing` distinctly and loudly. It is the one state a human must act on.
- Keep the reason field mandatory. It goes to PayHere as `description` and is the audit trail.

---

## 7. Keep the manual path

Do not delete it. Three reasons:

1. The API is **card-only** — a non-card payment has no other route.
2. PayHere's API can be down while the dashboard works.
3. `api_processing` resolution *is* the manual path — §5 depends on it existing.

The request → confirm split was built API-shaped on purpose. Automating replaces the pasted
reference with the API's returned one; the ledger, the states, the emails, the seat release and
the quote un-win are all unchanged.

---

## 8. Build order

| # | | why this order |
|---|---|---|
| 1 | §1 prerequisites — static IP confirmed, whitelisted, key created | everything else is unusable without it |
| 2 | Migration: statuses, `provider_message`, `api_attempted_at` | |
| 3 | Adapter `refund()` + token cache, against a fake | no PayHere contact in tests |
| 4 | Sandbox end-to-end: success, `-1`, `-2`, expired token, timeout | prove `unknown` behaves before live |
| 5 | Route + `api_processing` guard + stale alert | the §5 rule, tested |
| 6 | Ops UI: confirmation naming amount/payee, `api_processing` state | |
| 7 | Live smoke: one small real refund, reconciled by hand against the dashboard | |

Step 7 on a real payment, deliberately. A refund path that has never moved real money is not
proven.

---

## 9. Open questions for the owner

1. **Static outbound IP** — does the prod Render service have one? This gates everything.
2. **Threshold for a stronger confirmation** — typed amount above some figure, or same treatment
   for every refund?
3. **Partial refunds via API too, or full-only first?** Full-only is a smaller surface for the
   first release; the ledger already supports partials manually.
4. **Should `api_failed` auto-fall-back** to offering the manual flow inline, or just show the
   error and let the agent choose?
