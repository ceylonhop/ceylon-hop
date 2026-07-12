# Ceylon Hop — Backend Technical Specification

Status: draft v1.1 · Owner: founder + Claude Code · Last updated: 2026-06-17

This document specifies the backend, data model, operations tooling, and
communications needed to run Ceylon Hop as a real business. It is written to be
built incrementally by the founder working with Claude Code, favouring managed
services over bespoke infrastructure.

---

## 0. Confirmed scope (v1.1)

Clarifications from the founder that **override** the relevant sections below. We are
already an operating business; this backend formalises what is partly manual today.

> **⚠️ SUPERSEDED where noted (updated 2026-07-11).** These were Phase-1 assumptions and several no
> longer hold: pricing is **no longer stubbed or client-trusted** — the M11 quote engine is the
> server-authoritative pricing truth and bookings adopt the engine's recomputed total (GL-4), not the
> client's; PayHere is **wired and live in sandbox** (real sandbox charges), not a fake adapter. Email
> automation and the manual-concierge model still hold. Read the items below as historical rationale.

1. **PayHere keys exist, but Phase 1 stubs it.** We already hold live PayHere
   **hosted-checkout** API keys, so there's no gateway onboarding. But **Phase 1 builds
   the whole flow against a fake/stub PayHere adapter** (fake checkout + simulated
   webhook). **Wiring the real PayHere is a later, isolated step** (Phase 1.5), done
   only after the end-to-end pipeline is proven on the stub. (See §3, §15.)
2. **WhatsApp stays manual for now.** No WhatsApp Business API yet, so no automated
   WhatsApp. v1 automates **email only**; the concierge messages customers **by hand**.
   WhatsApp Business API automation is a **fast follow**. (See §10.)
3. **Pricing is stubbed initially.** The rate model isn't finalised, so v1 ships a
   placeholder pricing module and **trusts the front-end-computed total** at checkout.
   The authoritative server pricing engine + `rate_card` is a fast follow via the API.
   *Interim risk:* client-supplied totals aren't tamper-proof — acceptable at current
   volume, harden before scaling. (See §6.)
4. **Refunds are manual.** Cancellations/refunds are handled by staff in the PayHere
   dashboard; the system only **records** that a refund happened. No website-triggered
   refund. (See §9.3.)
5. **No customer login in v1.** Confirmation is the post-payment page + email; an
   optional tokenised "view your booking" link is the most we'd add. Customer accounts
   are deferred. (See §8.)
6. **No accounting integration in v1.** No accounting platform in use yet; deferred /
   optional. (See §12.)

**Net v1 (Phase 1) focus:** persist bookings + customer details → drive the flow with a
**stubbed** PayHere (fake checkout + simulated webhook) to reach `paid` → send email
confirmation + e-ticket → surface bookings in **Supabase Table Editor** (a free grid on
the real DB) so staff run concierge, dispatch and refunds manually. **Pricing stubbed,
PayHere stubbed, WhatsApp manual, no data mirror.** Real PayHere is a separate later step
(Phase 1.5).

---

## 1. Overview, goals, non-goals

**Product.** Ceylon Hop sells ground transport across Sri Lanka in three shapes:
1. **Single private transfer** — door-to-door AC car/van + driver between two points.
2. **Shared seat** — a reserved seat on a daily fixed-corridor service.
3. **Multi-stop trip** — a multi-day itinerary, either leg-by-leg private transfers
   or a chauffeur-guide who stays with the guest. Packaged **tours** feed into this.

The front end (marketing site, search, planner, booking, tours) already exists as a
static site. This spec covers the **brain behind it**.

**Goals**
- Take real bookings and real payments end-to-end (PayHere; v1 runs the flow on a
  **stubbed** gateway first — see §0.1).
- One authoritative pricing engine shared by site, ops, and receipts.
- Operate the business: dispatch drivers/vehicles, manage shared-seat inventory,
  handle changes/cancellations/refunds.
- Deliver the brand's "a real person messages you on WhatsApp" promise reliably.

**Non-goals (for now)**
- Rebuilding the front end (keep it static; add an API it calls).
- A native mobile app (a mobile-web driver portal is enough at first).
- Dynamic/surge pricing, loyalty, multi-language ops UI (later phases).

---

## 2. Guiding decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript front-to-back | Reuse existing JS logic; one toolchain |
| Backend + DB + Auth + Storage | **Supabase** (managed Postgres, Auth, Storage, Edge Functions) | Fewest moving parts for a founder + Claude; can be decomposed later |
| API style | REST over HTTPS, JSON | Simple, matches the existing client JS |
| Site hosting | Static on GitHub Pages / Vercel | Already live; auto-deploys from GitHub |
| Payments | **PayHere** (USD) | See §3 |
| WhatsApp | WhatsApp Business Platform via a BSP (360dialog / Twilio / Gupshup) | The concierge channel must be a real API, not `wa.me` |
| Email | Resend or Postmark | Transactional confirmations + e-ticket PDF |
| Maps | Google Places + Distance Matrix | Geocode exact pickups; real distance/ETA |
| Early ops UI | **Supabase Studio** now → **NocoDB/Retool on Postgres** | Work the real DB directly (no mirror); validate the workflow before a bespoke dashboard |

**Build approach.** Founder + Claude Code, built in vertical slices. Prefer managed
services and configuration over custom infrastructure. Ship the smallest thing that
can take a real booking, then automate the operational grind.

---

## 3. Payments — recommendation and rationale

**Use PayHere, charging in USD.**

- **Eligibility is the deciding factor.** Stripe does **not** support businesses
  registered in Sri Lanka. PayHere is purpose-built for SL businesses and settles to
  a local bank account.
- PayHere accepts international **Visa / Mastercard / Amex** and supports USD, which
  suits the predominantly foreign-tourist customer base and avoids FX surprises.
- It is **hosted checkout** — the customer enters card details on PayHere's page, not
  ours. This keeps Ceylon Hop out of PCI-DSS scope (huge compliance saving).
- It already matches the current UX (the simulated "PayHere" interstitial).

**When to add Stripe.** Only if/when you incorporate a foreign entity (US/UK/SG via
Stripe Atlas or similar) for better international card conversion and payout terms.
Treat the payment layer as an interface (see §9) so a second provider can slot in
without touching booking logic.

**Required PayHere capabilities used:** hosted checkout, server-to-server
**webhook/notify URL**, and a sandbox for test mode. (Refunds are manual per §0.4.)

**Phasing:** Phase 1 builds the flow against a **fake** PayHere adapter; wiring the real
keys (sandbox → live) is a separate later step (Phase 1.5; build-plan step 5.5).

---

## 4. System architecture

Four layers (see the architecture diagram in chat):

1. **Client surfaces** — web app (booking/planner/tours), ops dashboard, driver
   portal, and the customer's own WhatsApp/email.
2. **Application backend (TypeScript API)** — booking & itinerary, pricing engine,
   availability & dispatch, comms orchestrator; plus auth/RBAC, payment webhooks, and
   a background job queue.
3. **Data stores** — Postgres (system of record), object storage (e-tickets, photos),
   a cache/queue for jobs and rate limiting.
4. **External services** — PayHere, WhatsApp Business API, email, Google Maps,
   accounting.

All client surfaces talk only to the API. The API owns all writes to Postgres and is
the only component that calls payment/comms providers.

---

## 5. Data model

Postgres. `id` = uuid pk, plus `created_at`/`updated_at` on every table. Money stored
as integer minor units + ISO currency code (never floats). Enums are Postgres enums.

### 5.1 Demand
- **customer** — `name`, `email`, `whatsapp_e164`, `country`, `locale`, `marketing_opt_in`.
- **booking** — the umbrella. `customer_id`, `mode` (`private|shared|trip`),
  `status` (see §7), `currency`, `subtotal`, `discount_total`, `total`,
  `amount_due_now`, `pay_plan` (`deposit|full`), `source`, `notes`, `reference` (human
  code e.g. `CH-7K3QD`).

### 5.2 What was booked
- **transfer_request** (single/shared) — `booking_id`, `from_place_id`, `to_place_id`,
  `pickup_address`, `dropoff_address`, `travel_date` (nullable = flexible),
  `travel_time` (nullable = flexible), `vehicle_type`, `adults`, `children`, `bags`,
  `shared_departure_id` (nullable).
- **itinerary** (trip) — `booking_id`, `service_type` (`private|chauffeur`),
  `start_date`, `pax`, `vehicle_type`, `total_nights`.
- **leg** — `itinerary_id`, `seq`, `from_place_id`, `to_place_id`, `travel_date`
  (nullable), `distance_km`, `duration_min`, `price`, `assignment_id`.
- **stay** — `itinerary_id`, `seq`, `place_id`, `nights`.
- **booking_addon** — `booking_id`, `addon_code`, `qty`, `unit_price`.

### 5.3 Supply / fleet
- **place** — canonical places. `name`, `aliases[]`, `lat`, `lng`, `zone`,
  `is_airport`. (Seed from `routes-data.js` / `transfers-data.js`.)
- **corridor** — shared-service routes. `from_place_id`, `to_place_id`, `seat_price`,
  `seat_capacity_default`, `schedule` (cron/times), `active`.
- **vehicle** — `type` (`car|van`), `pax_capacity`, `bag_capacity`, `plate`,
  `active`.
- **driver** — `name`, `phone`, `languages[]`, `is_pro_hopper`, `rating`, `active`.
- **assignment** — `driver_id`, `vehicle_id`, `scope` (`leg|trip_day|shared_departure`),
  `ref_id`, `date`, `status` (`offered|accepted|en_route|completed|cancelled`).
- **shared_departure** — inventory. `corridor_id`, `date`, `time`,
  `seats_total`, `seats_booked`. Unique on `(corridor_id, date, time)`. Seat holds
  are transactional (see §9.4).

### 5.4 Money
- **rate_card** — versioned pricing config (see §6). One active version at a time.
- **payment** — `booking_id`, `provider` (`payhere|stripe`), `intent_ref`,
  `provider_txn_id`, `kind` (`deposit|full|balance|refund`), `amount`, `currency`,
  `status` (`pending|succeeded|failed|refunded`), `raw_payload` (jsonb), `idempotency_key`.

### 5.5 Operations & comms
- **concierge_task** — `booking_id`, `type` (`confirm_pickup|collect_details|follow_up`),
  `status`, `due_at` (computed on SL business hours), `assignee_id`.
- **message_log** — `booking_id`, `channel` (`whatsapp|email|sms`), `template`,
  `to`, `status` (`queued|sent|delivered|failed`), `provider_ref`, `payload`.
- **review_request** — `booking_id`, `sent_at`, `clicked_at`, `platform`.
- **staff_user** + **role** — RBAC (see §13).
- **audit_log** — `actor`, `action`, `entity`, `before`, `after`, `at`.

### 5.6 Key integrity rules
- A `shared_departure` can never have `seats_booked > seats_total` (DB check + atomic
  update on booking).
- `payment` writes are **idempotent** on `idempotency_key` (webhook retries are safe).
- Cancelling a booking releases held shared seats and frees assignments.
- `POST /bookings` is **idempotent on a client `Idempotency-Key`** — a resubmit or retry
  returns the existing booking, never a duplicate draft.
- The amount sent to the payment provider **always equals the booking's stored
  `amount_due_now`**; a mismatch is rejected (no silent over- or under-charge).

---

## 6. Pricing engine

The single source of truth for money. Ports the logic currently in
`transfers-data.js` to the server, reading from the active `rate_card`.

> **v1 reality (per §0.3):** the rate model isn't finalised. v1 ships a **stub** that
> accepts the front-end-computed total and records it on the booking; the functions and
> `rate_card` below are the **target** for the fast-follow once rates are defined. Build
> the booking flow against the stub now and swap in the real engine via the same API
> later — the call sites don't change.

**Functions (server module, also callable by the site for display):**
- `privateQuote(from, to, vehicle)` → `{ distance_km, duration_min, car, van }`
- `sharedOption(from, to)` → `{ corridor, seat_price, times, seats_left } | null`
- `tripQuote(stops[], vehicle, nights[])` → `{ legs[], base_total }`
- `chauffeurQuote(trip)` → adds per-day fee × days
- `applyDiscounts(quote, { children })` → child discount, add-ons
- `depositFor(total, pay_plan)` → amount due now

**rate_card shape:** `per_km_rates`, `vehicle_multipliers`, `route_overrides`,
`chauffeur_day_fee`, `child_discount_pct`, `addon_prices`, `deposit_pct`,
`season_modifiers`, `currency`.

**Parity requirement (critical):** the price shown on the site, the price stored on
the booking, and the amount charged by PayHere are produced by the **same** call. The
client may *display* a quote, but the server **re-computes and is authoritative** at
checkout. Quotes are stamped with the `rate_card` version for auditability.

---

## 7. Booking lifecycle (state machine)

```
draft ─▶ payment_pending ─▶ paid(deposit|full) ─▶ confirmed ─▶ in_progress ─▶ completed
                  │                                   ▲
                  └────────────── awaiting_details ───┘   (flexible date/time bookings)
any non-terminal ─▶ cancelled ─▶ refunded            └─▶ no_show
```

- **draft** — quote built, not yet submitted.
- **payment_pending** — checkout opened; awaiting PayHere webhook.
- **paid** — webhook confirmed (deposit or full). Triggers (v1): confirmation **email**
  + e-ticket PDF + create a `confirm_pickup` concierge task. *(WhatsApp is sent
  **manually** in v1 — §0.2; auto-WhatsApp is a fast follow.)*
- **awaiting_details** — "decide later" bookings; concierge collects exact date/time.
- **confirmed** — concierge verified details **and** driver/vehicle assigned.
- **in_progress / completed** — driver status updates; completion triggers review request.
- **cancelled / refunded / no_show** — releases inventory; refund honours the
  free-cancellation policy.

Each transition is logged (`audit_log`) and may enqueue notifications/alerts (§10).

---

## 8. API surface (REST)

Public (rate-limited, no auth) — called by the website:
- `POST /quotes` — body describes single/shared/trip; returns authoritative quote.
- `POST /bookings` — create `draft` from a quote; returns booking + reference.
- `POST /bookings/:id/checkout` — create PayHere session; returns redirect params.
- `GET  /bookings/:id` (tokenised link) — booking status for the confirmation page.
- `GET  /places?q=` , `GET /corridors`, `GET /tours` — catalogue reads.

Webhooks:
- `POST /webhooks/payhere` — verify signature → upsert `payment` → advance booking.

Staff (authenticated, RBAC):
- `GET/PATCH /admin/bookings`, `/admin/bookings/:id/assign`, `/cancel`, `/refund`
- CRUD `/admin/drivers`, `/admin/vehicles`, `/admin/corridors`, `/admin/rate-card`
- `GET/PATCH /admin/shared-departures` (inventory)
- `GET/PATCH /admin/concierge-tasks`

Driver (authenticated, driver role):
- `GET /driver/jobs?date=`, `POST /driver/jobs/:id/status`

---

## 9. Payments flow

### 9.1 Happy path
*This is the **target** flow with real PayHere. In v1 the identical steps run against the
**stubbed** adapter with a simulated webhook (§0.1).*

1. Site calls `POST /bookings` (idempotent on a client `Idempotency-Key`) → `draft`.
2. Site calls `POST /bookings/:id/checkout`; server **re-prices**, creates a `payment`
   (`pending`, with `idempotency_key`), returns PayHere hosted-checkout params. **The
   checkout amount always equals the booking's `amount_due_now`** — a mismatch is rejected.
3. Customer pays on PayHere.
4. PayHere calls `POST /webhooks/payhere`; server **verifies signature**, marks
   `payment` succeeded, advances booking to `paid`, fires notifications.
5. Customer is redirected back to the confirmation page, which reads `GET /bookings/:id`.

### 9.2 Deposit vs full
`pay_plan` decides `amount_due_now`. Deposits create a later `balance` payment
(collected by concierge link or on the day). Chauffeur trips default to deposit.

### 9.3 Refunds / cancellation
**v1 (per §0.4): manual.** Staff issue the refund in the **PayHere dashboard**, then
mark the booking cancelled in the system, which records a `refund` payment row (for
reporting) and releases inventory/assignments. No website-triggered refund API call.
Automating this is a later-phase option.

### 9.4 Concurrency & idempotency
- Shared-seat booking uses a transactional `UPDATE ... WHERE seats_booked + n <=
  seats_total` to prevent oversell.
- Webhook handler is idempotent on `idempotency_key`; duplicate notifies are no-ops.

---

## 10. Communications & notifications

**Channels:** WhatsApp (primary brand channel), email (receipts/tickets), SMS (optional).

> **v1 reality (per §0.2):** only **email is automated** in v1. WhatsApp messages are
> sent **manually** by the concierge from the brand phone. The event→message matrix
> below is the **target state**; treat the WhatsApp column as a fast follow that lands
> when the WhatsApp Business API is integrated. The booking system should still *create
> the concierge task* so staff know to message — it just won't auto-send yet.

**Event → message matrix:**

| Event | WhatsApp | Email | Ops/driver |
|---|---|---|---|
| Payment succeeded | Confirmation template | Receipt + e-ticket PDF | New-booking alert |
| Flexible booking | "We'll confirm your time" | — | Create collect-details task |
| Concierge confirms pickup | Updated pickup details | — | — |
| Driver assigned | — | — | Job notice to driver |
| T-24h / day-of | Reminder | Reminder | — |
| Trip completed | Thank-you + review ask | — | — |
| Payment failed / leg unassigned / low seats | — | — | Ops alert |

**Concierge workflow.** `paid` bookings create a `confirm_pickup` task with a `due_at`
computed against **Sri Lanka business hours (GMT+5:30, ~8am–9pm)**; overnight bookings
roll to next morning. A team WhatsApp inbox (BSP-provided or built on the API) lets
concierge reply from the brand number. SLA breaches raise an ops alert.

**Templates.** WhatsApp message templates must be pre-registered and approved by Meta —
**start this early** (see §16).

---

## 11. Operational backend

**Ops dashboard** (staff): booking list/detail with status; assign driver + vehicle to
each leg / trip-day / shared departure; manage shared-departure schedule + seat
inventory; process cancellations and refunds; message customers; edit `rate_card`,
places, corridors, tours.

**Driver portal** (mobile web): today's jobs, customer + pickup details, one-tap
status (`en_route` → `completed`).

**Interim ops UI (no data mirror).** Staff work directly on the Postgres data:
**Supabase Table Editor** now (free, zero setup); when manual ops grows (within ~6
months) put **NocoDB** (open-source, free; unlimited users/records self-hosted) or
**Retool** (free tier = up to 5 users; granular RBAC + audit logging are paid) **on the
same Postgres**. Build the bespoke dashboard (Phase 2)
only once the real process is known. Avoid Airtable — its free tier caps at 1,000
records/base and duplicates the data.

---

## 12. Integrations

- **Google Maps** — Places Autocomplete for exact pickup/drop-off; Distance Matrix for
  km/min feeding pricing and driver ETAs.
- **Accounting (Xero/QuickBooks)** — deferred (per §0.6); no platform in use yet. A
  CSV export of payments covers reporting needs until then.
- **Reviews (Tripadvisor)** — post-trip review request links; track click-through.

---

## 13. Security, privacy & compliance

- **PCI:** hosted checkout only; card data never touches our servers. Document the SAQ-A
  posture.
- **PII / GDPR:** customers include EU/UK/AU travellers. Capture marketing consent,
  define data-retention windows, support deletion requests, document data flows.
- **RBAC roles:** `admin` (all), `ops` (bookings/dispatch/inventory), `concierge`
  (tasks/comms, read bookings), `finance` (payments/refunds/exports), `driver`
  (own jobs). Enforce in the API and Postgres row-level security.
- **Secrets:** provider keys in a managed secret store; never in the repo. Verify all
  webhook signatures.
- **Resilience:** daily automated Postgres backups + periodic restore drills;
  `audit_log` on every staff mutation.

---

## 14. Infrastructure & DevOps

- **Environments:** `dev`, `staging`, `prod`, each with its own DB + provider
  sandbox/live keys.
- **CI/CD:** GitHub Actions — typecheck/test on PR; deploy on merge to `main`.
- **Hosting:** API on Vercel/Supabase Edge Functions; Postgres + storage on Supabase.
- **Observability:** error tracking (Sentry), structured logs, uptime monitor, alerting
  on webhook failures and job-queue backlog.
- **Config:** `rate_card`, corridors, tours, and templates are data (DB), not code —
  editable without a deploy.

---

## 15. Phased delivery plan

| Phase | Deliverable | "Done when…" |
|---|---|---|
| **0 Foundations** | Supabase project, data model v1, staff auth, CI/CD, **stub** pricing module | The booking flow can create + persist a draft with a total |
| **1 End-to-end (stubbed payment)** | Booking persistence, **stubbed** PayHere (fake checkout + simulated webhook), email confirm + e-ticket PDF, Supabase ops view, auto-create concierge task | A *simulated* payment creates a `paid` booking, emails confirmation, and is visible to staff in Supabase |
| **1.5 Real payments** | Wire **existing** PayHere keys (sandbox → live) + webhook signature verification, behind the same adapter | A real sandbox PayHere payment creates a `paid` booking |
| **2 Run operations** | Ops dashboard, drivers/vehicles, dispatch/assignment, **record** manual cancellations/refunds, shared-seat inventory + schedules, **authoritative pricing engine + `rate_card`** | Staff can assign a driver; refunds and prices are tracked in-system |
| **3 Automate comms (fast follow)** | WhatsApp Business API + templates, reminders, concierge SLA timers, review requests, ops alerts | Confirmations/reminders auto-send on WhatsApp, no manual step |
| **4 Scale & polish** | Driver app, reporting/analytics, accounting sync, seasonal pricing, multi-currency | — |

**Phase ↔ build-plan milestone map.** The milestones in
[`build-plan.md`](./build-plan.md) (M0, M1, …) are the **canonical execution order**;
the phases above are thematic groupings, and one phase may span several milestones:

| Phase | Milestones |
|---|---|
| 0 Foundations | M0 |
| 1 End-to-end (stubbed payment) | M1–M6 |
| 1.5 Real payments + live site | M5.5, M7 |
| 2 Run operations | M8 (Maps), M9 (multi-stop), M10 (shared), M11 (pricing engine), M12 (ops dashboard) |
| 3 Automate comms | M13 (WhatsApp), M14 (reminders/reviews) |
| 4 Scale & polish | M15 (reporting), and beyond |

---

## 16. Pre-build checklist (start now — these have lead times)

- [x] **PayHere** — live merchant account + API keys already in hand. Action: locate
      keys, confirm the notify/webhook URL setting, and test in sandbox first.
- [ ] **WhatsApp Business Platform** *(fast follow)* — pick a BSP, complete Meta
      business verification, submit message templates for approval. Start early; it's
      the slowest dependency.
- [ ] **Google Maps API** project + billing + key restrictions.
- [ ] **Email domain** — verify sending domain (SPF/DKIM) with Resend/Postmark.
- [ ] **Supabase** project + Postgres region (close to customers/ops).
- [ ] Business bank account for PayHere settlement.

---

## 17. Open questions

1. ~~Entity status~~ — resolved: operating business with live PayHere. Revisit only if
   incorporating a foreign entity for Stripe later.
2. Shared-ride operations: are corridors/schedules fixed, or do they vary seasonally?
3. Driver model — employees, contractors, or a partner fleet? (affects payouts + the
   driver portal).
4. Expected booking volume at launch (sizes the inventory/dispatch automation).
5. Cancellation/refund policy exact terms (drives the refund logic).
6. Data residency / which regions customers come from (GDPR scope).
