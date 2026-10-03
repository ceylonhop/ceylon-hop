# Server-side GA4 purchase & refund tracking: design

**Status:** draft for owner review (2026-10-03). **Code base read:** `origin/main` @ b43cd9ae.
**Related:** `docs/superpowers/plans/2026-10-03-ga4-measurement-upgrade.md` (rev 2). This spec **replaces** that plan's Phase 5 (browser-side purchase details) and reuses its Phase 2 `knownPlace()` module.

## 1. Problem

GA4 learns about a sale only when the customer's browser returns from PayHere and fires `purchase` (`manage.html:161-174`, `pay.html:280-292`).

**Measured gap.** On 2026-10-02 GA4 held 5 of 7 paid bookings since 2026-09-28. GA4 never sees:
- closed tabs;
- `manage.html`'s minimal-paid path (`manage.html:514-516`);
- ops "mark paid" settlements;
- ride-board seat charges;
- refunds.

The events it does get carry only `transaction_id, value, currency, payment_type`. So GA4 cannot say *what* sold, *to whom*, or *from which marketing*, and those are the owner's questions.

## 2. Goal

Every settled online payment and every confirmed refund reaches GA4 **exactly once**. Each one:
- comes from our server;
- carries privacy-safe sale details;
- is tied to the buyer's GA visitor and session when we have them.

GA4 revenue then equals money actually received through the system, net of refunds.

## 3. Acceptance criteria: the owner's user stories

Each criterion must be demonstrable in the named GA4 place after release, against the ops booking list. *Verify* gives the check.

### In scope (must pass)

| # | Story: as the owner I want to know… | GA4 place | Verify |
|---|---|---|---|
| 1 | Total revenue per week/month and trend | Reports → Monetization overview / Transactions | Over 14 days, Σ GA4 purchase revenue = Σ succeeded payments (non-test, online + manual + board) from the DB, ±0 |
| 2 | Revenue after refunds | Transactions (refund rows) + Explore "Purchase revenue − Refund amount" | Every confirmed refund in the window appears with its amount |
| 3 | Average booking value; deposit vs full | Explore: `payment_type`, metric `booking_total` | Deposit bookings show `payment_type=deposit` and `booking_total` > value |
| 4 | Revenue by service | Explore: dimension `service_type` | All 4 types present when sold; totals match the DB report |
| 5 | Revenue by route and region | Explore: `route`, `region_route`; Monetization → Ecommerce purchases (item = route) | Top 5 routes match `docs/analytics/route-report.sql` for the same window |
| 6 | What promo codes cost and bring in | Explore: built-in `coupon`, metric `discount` | Every promo booking shows its code and discount |
| 7 | Which channels bring **paying** customers | Explore: Session source/medium × Purchase revenue | Website-originated purchases carry the source of the checkout session (shadow-mode check §8 passes) |
| 11 | Lead time | Explore: metric `days_to_travel` | Values match travel date − payment date |
| 20 | Buyers' home countries | Explore: `customer_country` | Matches the booking's country, not the network guess |
| 21 | Party size and vehicle | Explore: metric `pax`, dimension `vehicle_type` | Matches the bookings |
| 23 | New vs returning **buyers** | Explore: `customer_type` | A customer's 2nd paid booking reads `returning` (from the DB, not cookies) |
| 27 | GA4 purchases match real bookings | Transactions vs ops "Recently booked" | 100% of non-test paid bookings settled ≥24h ago are present |

### Must not regress (already working, untouched by this design)

- **13** checkout step drop-off (`checkout_step`)
- **14** payment failures and reasons
- **15** reprices
- **16** unpriceable routes and out-of-coverage places
- **18** lapsed quotes
- **19** WhatsApp clicks
- **22** device × purchase (device comes from the stored session)
- **28** internal traffic excluded

### Out of scope here (own spec or plan)

| # | Story | Where |
|---|---|---|
| 8 | WhatsApp revenue labelled WhatsApp | Plan rev 2, Phase 4 (short-link UTMs) |
| 9 | Website visit behind each WhatsApp sale | Visit-code spec (schema on `quotes`) |
| 10 | Pages that lead to bookings | `content_group` follow-up |
| 12 | Full funnel drop-off | Funnel exploration, scheduled 2026-10-26 |
| 17 | Quotes sent → opened → paid | `generate_lead` spec |
| 24 | Age / gender / interests | Owner turns on Google signals (currently **off**, checked 2026-10-03) |
| 25-26 | Ad ROAS, audiences | Ads spec, when ads start; it will reuse this design's server events |

## 4. Decisions

Proposed. The owner confirms them on review.

| # | Decision | Proposed | Why |
|---|---|---|---|
| D1 | Who sends GA4 `purchase` | **The server only.** GTM's "GA4 - purchase" tag is paused. The browser keeps pushing `purchase` to the dataLayer, so Google Ads, Meta and TikTok pixels still fire | Google's MP docs describe no purchase de-duplication (checked 2026-10-03), so two senders risk double revenue |
| D2 | What `value` means | **Money received in this payment** (a deposit counts as the deposit). The full price goes as `booking_total` | GA4 revenue then equals the bank. Booked value stays available |
| D3 | Ride board | **Included.** Each charged member is a purchase | It is real revenue, and today nothing reports it |
| D4 | Chargebacks (`reversal` webhook outcome) | **Not sent in v1.** They keep today's alert | Rare. Ops already handles them by hand |
| D5 | Visitor id for board charges | **Synthetic id**, so the revenue is counted with source `(not set)` | Board members join via Google sign-in. Capturing `_ga` there needs a second schema change, which isn't worth it at board volume |
| D6 | Rollout | **Shadow mode first** (§8): send `purchase_server` for ~2 weeks next to the browser `purchase`, compare, then switch | Whether a server event inherits the checkout session's source is not documented. Prove it before relying on it |

## 5. Design

### 5.1 Units

Each unit has one job.

| Unit | Responsibility | Depends on |
|---|---|---|
| `adapters/ga4.ts`: `Ga4Adapter` interface, `MeasurementProtocolAdapter`, `FakeGa4Adapter` | POST one hit to `https://www.google-analytics.com/mp/collect?measurement_id=…&api_secret=…`, 8 s timeout, non-2xx → failure (pattern: `adapters/email.ts` Resend adapter) | fetch |
| `services/analytics/knownPlace.ts` | Place → known town / region / type, or `Other` (plan rev 2, Task 2) | `KNOWN_PLACES` |
| `services/analytics/purchaseFacts.ts` | Booking → sale facts (plan rev 2, Task 7, minus `pickup_type` / `dropoff_type`, see §5.4) | knownPlace |
| `services/analytics/ga4Hits.ts` | **Pure.** Builds the MP payloads: `purchaseHit(booking, payment, ctx)`, `refundHit(booking, refund, ctx)`, `boardChargeHit(list, member, amount, ctx)`. Enforces the ≤25-param and ≤100-char limits | purchaseFacts |
| `services/analytics/ga4Sender.ts` | `reportPayment(paymentId)`, `reportRefund(refundId)`, `reportBoardCharge(listId, memberSub)`. Looks up data, skips test bookings, claims a ledger row, sends, marks sent or releases | repos, adapter, ledger, `isTeamEmail` |
| `ga4_event_log` table + repo | Exactly-once ledger: `event_key` unique (`purchase:<paymentId>`, `refund:<refundId>`, `board:<listId>:<memberSub>`), `status` (`claimed`/`sent`), `attempts`, `last_error`, `sent_at` | migration |
| Browser `window.chGaIds()` in `analytics.js` | Read the GA client id from cookie `_ga` and the session id from `_ga_XEW62ZD7B3`, plus the stored consent choice | cookies, localStorage |
| Sweep step in `POST /admin/jobs/notifications` | Re-send unsent events, up to 72 h old (the MP backdating limit) | ga4Sender |

### 5.2 Data flow

**Checkout**
1. `booking.js`, `manage.html` and `pay.html` all call `POST /bookings/:id/checkout` (`bookings.ts:952`). They add `ga: chGaIds()` to the body: `{ clientId, sessionId, adConsent: 'granted'|'denied'|'unknown' }`.
2. The route reads it off the raw body, using the same pattern as `customerNotesFrom` (`bookings.ts:439-502`).
3. It validates the shapes:
   - `clientId`: `^\d+\.\d+$`
   - `sessionId`: `^\d{6,12}$`
4. It stores them on the booking: new nullable columns `ga_client_id`, `ga_session_id`, `ga_ad_consent`. The latest checkout wins.
5. Nothing is required. Missing or invalid values are ignored, so the checkout never fails because of analytics.

**Settlement** (each hook is best-effort: `void ga4.reportX(...).catch(report)`, never awaited on the money path)

| Path | Hook point | Event |
|---|---|---|
| PayHere webhook, outcome `settled` | `webhooks.ts`, after the team "Paid:" alert (`:429-440`) | purchase |
| Webhook outcomes `double_capture` / `unexpected_booking_state` (money taken) | same block family (`:331-353`, `:455-466`) | purchase (keyed per payment; `transaction_id` gets a suffix, §5.4) |
| Ops mark-paid | `admin.ts`, after `claimWonQuote` (`:546`) | purchase |
| Ride-board cutoff charge `succeeded` | `rideBoardCutoff.ts`, after the confirm block (`:192-226`), for `chargedOk` minus `indeterminate` | purchase (board) |
| Refund confirmed (manual or API) | `afterRefundConfirmed`, last (`admin.ts:247-298`) | refund |

**Retry.** The sweep finds:
- succeeded payments, confirmed refunds and charged board members from the last 72 h;
- that have no `sent` ledger row;
- that aren't test bookings.

It calls the same `report*` functions. Re-entry is safe, because the ledger claim is atomic on `event_key`.

### 5.3 The purchase hit

```json
{
  "client_id": "<ga_client_id, or 'srv.' + bookingId when unknown>",
  "timestamp_micros": "<payment.settledAt>",
  "consent": { "ad_user_data": "<GRANTED|DENIED>", "ad_personalization": "<GRANTED|DENIED>" },
  "events": [{ "name": "purchase", "params": { … } }]
}
```

- `consent` (both fields the same value) mirrors the site's ad-consent logic (`booking.html:25-29`):
  - stored choice `granted` → `GRANTED`;
  - stored choice `denied` → `DENIED`;
  - no stored choice → `GRANTED` only if the booking's billing/customer country is known **and** outside the EEA, UK and Switzerland, otherwise `DENIED`.
- Board charges have no stored visitor:
  - `client_id` = `srv.` + the first 16 hex characters of SHA-256(`event_key`). It is deterministic, so retries reuse it, and it never contains the member's Google `sub`.
- In shadow mode the event name is `purchase_server`.

### 5.4 Event parameters

Hard limit is 25 per event; strings must be ≤100 characters.

| # | Param | Source |
|---|---|---|
| 1 | `transaction_id` | `booking.reference`. A second succeeded payment on the same booking: `reference-<first 6 of paymentId>`. Board: `<list.code>-<first 8 hex of SHA-256(member.sub)>` (never the raw `sub`) |
| 2 | `value` | `payment.amount / 100` (D2) |
| 3 | `currency` | `payment.currency` |
| 4 | `payment_type` | `deposit` if `amount < booking.total`, else `full` |
| 5 | `session_id` | `ga_session_id` (omitted when unknown) |
| 6 | `engagement_time_msec` | `1` |
| 7 | `items` | one item: `item_id` = `route`, `item_name` = `route`, `item_category` = `service_type`, `price` = `value`, `quantity` = 1. This makes Ecommerce purchases → Item name work |
| 8 | `service_type` | purchaseFacts |
| 9 | `route` | purchaseFacts (`Known town → Known town`, or `Other`) |
| 10 | `region_route` | purchaseFacts |
| 11 | `pickup` | purchaseFacts |
| 12 | `dropoff` | purchaseFacts |
| 13 | `pickup_region` | purchaseFacts |
| 14 | `dropoff_region` | purchaseFacts |
| 15 | `pax` | purchaseFacts |
| 16 | `vehicle_type` | purchaseFacts |
| 17 | `booking_total` | `booking.total / 100` |
| 18 | `coupon` | `promoDiscount(b).code` (`services/notifications.ts:195-198`) |
| 19 | `discount` | `promoDiscount(b).cents / 100` |
| 20 | `travel_month` | `YYYY-MM` of the first travel date |
| 21 | `days_to_travel` | whole days from settlement date to first travel date |
| 22 | `customer_country` | `booking.billing.country ?? customer.country` (a country **name**, e.g. "United Kingdom") |
| 23 | `customer_type` | `new` or `returning`: does the customer have an earlier non-test booking with a succeeded payment |
| 24 | `channel` | `booking.channel` (`website` / `whatsapp`; board → `ride_board`) |
| 25 | *(spare, kept free)* | — |

- `pickup_type` and `dropoff_type` (from plan rev 2) are **dropped** to stay within 25.
- A unit test asserts every built hit has ≤25 params and every string is ≤100 characters.

**Refund hit:**
- `name: 'refund'`
- `transaction_id`: the original purchase's id
- `value`: `refund.amountCents / 100`
- `currency`
- same `client_id` / `session_id` (if known)
- `items`: the same single item, so item revenue nets out
- `refund_reason`: `refund.reason`, cut to 100 characters, and only if it contains no email or phone pattern. Otherwise it is omitted.

### 5.5 Privacy

Never sent:
- name, email, phone or street address;
- typed place text (all places go through `knownPlace`, so anything unknown is `Other`);
- tokens, the ride-board member `sub`, the booking id.

Allowed: booking reference (already on customer emails and in GA4 today), towns, regions, a country name, counts, money.

**Test bookings are never sent:** `isTeamEmail(customer.email, TEAM_EMAILS)`, which needs `teamEmails` threaded into the webhook, admin and cutoff deps. The same check uses `member.email` for board charges.

### 5.6 Errors

- **Analytics never blocks money.** Every hook is fire-and-forget with `.catch(deps.reportError)`.
- **Adapter failure:** the ledger row goes back to unsent, `attempts++`, `last_error` is recorded, and the sweep retries.
- **After 5 failed attempts:** one throttled ops alert (`kind: 'ga4_send_failed'`, through the existing `ThrottledAlerts`).
- **No `GA4_API_SECRET` set:** the real adapter is never constructed (`FakeGa4Adapter`, dormant), the same as `RESEND_API_KEY`.

### 5.7 Configuration

All of these are config changes, so the owner sets them. They're declared like the `RESEND_API_KEY` / `SENTRY_DSN` "dormant until set" pattern.

| Var | Meaning |
|---|---|
| `GA4_MEASUREMENT_ID` | `G-XEW62ZD7B3` |
| `GA4_API_SECRET` | Created by the owner in GA4 → Admin → Data streams → Ceylon Hop Web → Measurement Protocol API secrets |
| `GA4_SERVER_EVENT_NAME` | `purchase_server` (shadow mode) or `purchase` (live). The default is `purchase_server`, so a mis-deploy can never double-count |

### 5.8 Schema

One migration, which **releases to staging on merge** (auto-applied on boot).

**`bookings`:**
- add nullable `ga_client_id text`, `ga_session_id text`, `ga_ad_consent text`;
- add CHECK constraints for the shapes in §5.2.

**New `ga4_event_log` table:**
- columns `id uuid pk`, `event_key text unique not null`, `kind text`, `status text` (`claimed`|`sent`), `attempts int default 0`, `last_error text`, `created_at`, `sent_at`;
- RLS enabled (`rlsEnabled.test.ts` requires it).

Migration format: hand-written SQL plus a journal entry after `0062`, with a per-migration test in the style of `routeVariantMigration.test.ts`.

### 5.9 GTM and GA4 changes (owner-visible)

| When | Change |
|---|---|
| Shadow mode start | **GA4:** register the new dimensions and metrics (§5.4: dims `service_type, route, region_route, pickup, dropoff, pickup_region, dropoff_region, vehicle_type, travel_month, customer_country, customer_type, channel`; metrics `pax, booking_total, discount, days_to_travel`), 26/50 dims. Do **not** mark `purchase_server` as a key event |
| Switch-over | Set `GA4_SERVER_EVENT_NAME=purchase` and redeploy. **GTM:** pause "GA4 - purchase" and publish (Ads, Meta and TikTok purchase tags stay on the browser event) |

## 6. Testing

- **Pure units (Vitest):** `ga4Hits` (every field above; the param-count and length guards; test booking → no hit; deposit vs full; second-payment suffix; refund mirrors purchase), `knownPlace`, `purchaseFacts`, `chGaIds()` cookie parsing (`GA1.1.123.456` → `123.456`; both `GS1` and `GS2` session cookie formats).
- **Sender:** the ledger gives exactly-once under a concurrent double call; adapter failure → retried by the sweep; 5 failures → one alert; no sends when no secret is set.
- **Routes (with `FakeGa4Adapter`):**
  - webhook `settled` → exactly one hit; `duplicate` webhook → no new hit;
  - mark-paid → hit; refund confirm → refund hit;
  - board cutoff with `succeeded` / `unknown` → hits only for `succeeded`;
  - checkout stores `ga` ids and ignores malformed ones.
- **Web:** the three checkout callers send `ga`. A blocked `_ga` cookie → `ga` absent and checkout still works.
- **Migration test:** columns, CHECK constraints, RLS, journal order.
- **Live check before switch-over:** see §8.

## 7. Rollout

1. **PR 1:** `knownPlace` + route report (already planned, rev 2 Phase 2).
2. **PR 2:** migration + checkout capture + `chGaIds()`.
   - Merging releases the migration to **staging**.
   - Promoting needs the owner's OK, because the migration ships with it.
3. **PR 3:** adapter, hits, sender, hooks, sweep, config (dormant).
   - Promote.
   - The owner sets `GA4_API_SECRET` (shadow name is the default).
4. **Shadow mode, ~2 weeks** (§8).
5. **Switch-over:** env var to `purchase`, then GTM publish pausing the browser GA4 purchase tag. Do both the same hour.

## 8. Shadow-mode verification (the go/no-go gate for D6)

For every booking paid in the window, pair the browser `purchase` with the server `purchase_server` by `transaction_id`.

**Go when all hold:**
1. ≥95% of pairs share the same session source/medium. That proves the server event inherits the checkout session.
2. `purchase_server` covers 100% of non-test paid bookings older than 24 h (story 27).
3. Server revenue = DB revenue to the cent.
   - Only an event named `purchase` fills GA4's revenue metrics. So in shadow mode, compare using Explore → event name `purchase_server`, metric **Event value** (the sum of `value`).

**If check 1 fails:** server events land as `(not set)` or new sessions. Then stay on D1-alt instead: keep the browser GA4 `purchase` for attribution and use `purchase_server` only for revenue completeness. This is reported and not double-counted, because the names differ. The owner decides.

## 9. Known limits

- **Cash or bank-transfer balances** that nobody records as a payment are invisible. There is no online balance path (`manage.html:257`, `bookings.ts:199`).
- **Nothing older than 72 h can be sent**, so history before go-live is not loaded into GA4. The DB route report covers history.
- **WhatsApp sales** are attributed to the pay-link session, not the discovering visit (stories 8-9 are out of scope).
- **Country** is the booking's country *name* as entered (phone country or billing), not nationality.
- **`customer_type`** counts only bookings since this system went live.
- **Ride-board refunds are not sent.** Board charges have no `payments` row, so the refund tool doesn't cover them and they're refunded by hand. Board revenue in GA4 is gross of those refunds.
