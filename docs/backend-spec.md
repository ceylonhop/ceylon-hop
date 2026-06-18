# Ceylon Hop — Backend Technical Specification

Status: draft v1 · Owner: founder + Claude Code · Last updated: 2026-06-17

This document specifies the backend, data model, operations tooling, and
communications needed to run Ceylon Hop as a real business. It is written to be
built incrementally by the founder working with Claude Code, favouring managed
services over bespoke infrastructure.

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
- Take real bookings and real payments end-to-end.
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
| Early ops UI | **Airtable/Notion** synced from the API | Validate the workflow before building a custom dashboard |

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
**webhook/notify URL**, refunds API (for free-cancellation), pre-auth or
full-capture, and a sandbox for test mode.

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

---

## 6. Pricing engine

The single source of truth for money. Ports the logic currently in
`transfers-data.js` to the server, reading from the active `rate_card`.

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
- **paid** — webhook confirmed (deposit or full). Triggers: confirmation WhatsApp +
  email + e-ticket PDF + create `confirm_pickup` concierge task.
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
1. Site calls `POST /bookings` → `draft`.
2. Site calls `POST /bookings/:id/checkout`; server **re-prices**, creates a `payment`
   (`pending`, with `idempotency_key`), returns PayHere hosted-checkout params.
3. Customer pays on PayHere.
4. PayHere calls `POST /webhooks/payhere`; server **verifies signature**, marks
   `payment` succeeded, advances booking to `paid`, fires notifications.
5. Customer is redirected back to the confirmation page, which reads `GET /bookings/:id`.

### 9.2 Deposit vs full
`pay_plan` decides `amount_due_now`. Deposits create a later `balance` payment
(collected by concierge link or on the day). Chauffeur trips default to deposit.

### 9.3 Refunds / cancellation
Cancellation within the free-cancellation window → call PayHere refund API → record a
`refund` payment → release inventory/assignments → notify customer.

### 9.4 Concurrency & idempotency
- Shared-seat booking uses a transactional `UPDATE ... WHERE seats_booked + n <=
  seats_total` to prevent oversell.
- Webhook handler is idempotent on `idempotency_key`; duplicate notifies are no-ops.

---

## 10. Communications & notifications

**Channels:** WhatsApp (primary), email (receipts/tickets), SMS (optional fallback).

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

**Interim (Phase 1–2):** mirror bookings into **Airtable** via the API so ops can run
on a familiar grid while the workflow is validated. Build the custom dashboard in
Phase 2 once the real process is known.

---

## 12. Integrations

- **Google Maps** — Places Autocomplete for exact pickup/drop-off; Distance Matrix for
  km/min feeding pricing and driver ETAs.
- **Accounting (Xero/QuickBooks)** — export revenue + driver payouts (Phase 4).
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
| **0 Foundations** | Supabase project, data model v1, staff auth, CI/CD, pricing engine ported | A quote API returns the same numbers the site shows today |
| **1 Take real money** | Booking persistence, PayHere (sandbox→live) + webhook, email confirm + e-ticket PDF, Airtable mirror | A real card payment creates a `paid` booking and sends a confirmation |
| **2 Run operations** | Ops dashboard, drivers/vehicles, dispatch/assignment, cancellation/refund, shared-seat inventory + schedules | Staff can assign a driver and the customer can be refunded |
| **3 Automate comms** | WhatsApp Business API + templates, reminders, concierge queue + SLA, review requests, ops alerts | Confirmations and reminders go out automatically with no manual step |
| **4 Scale & polish** | Driver app, reporting/analytics, accounting sync, seasonal pricing, multi-currency | — |

---

## 16. Pre-build checklist (start now — these have lead times)

- [ ] **PayHere live merchant account** — business registration / KYC.
- [ ] **WhatsApp Business Platform** — pick a BSP, complete Meta business verification,
      submit message templates for approval.
- [ ] **Google Maps API** project + billing + key restrictions.
- [ ] **Email domain** — verify sending domain (SPF/DKIM) with Resend/Postmark.
- [ ] **Supabase** project + Postgres region (close to customers/ops).
- [ ] Business bank account for PayHere settlement.

---

## 17. Open questions

1. Sri Lanka business entity status (affects PayHere onboarding and future Stripe).
2. Shared-ride operations: are corridors/schedules fixed, or do they vary seasonally?
3. Driver model — employees, contractors, or a partner fleet? (affects payouts + the
   driver portal).
4. Expected booking volume at launch (sizes the inventory/dispatch automation).
5. Cancellation/refund policy exact terms (drives the refund logic).
6. Data residency / which regions customers come from (GDPR scope).
