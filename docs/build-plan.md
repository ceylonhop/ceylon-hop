# Ceylon Hop — Backend Build Plan (agent-team edition)

Status: v1 · Last updated: 2026-06-17 · Companion to [`backend-spec.md`](./backend-spec.md)

A step-by-step, **build → test → verify** plan sized for an AI agent team. Every step
is small, independently testable, and ends with a **human checkpoint** you can run to
confirm it works. External services (PayHere, Google, email) are added late and always
behind an interface with a fake, so early steps never depend on them. Ops staff work
directly on the Postgres data (Supabase Studio → NocoDB/Retool) — no mirror to a
separate tool.

---

## How to use this document

- **One step = one branch = one PR.** An agent claims the lowest-numbered step whose
  dependencies are all merged. Branch name: `step-<id>-<slug>` (e.g. `step-1.4-post-single`).
- A step is **done** only when: TypeScript compiles, **all tests pass**, lint passes,
  the human checkpoint succeeds, and **no files outside the step's scope changed**.
- If a step feels ambiguous or needs out-of-scope changes, the agent **stops and asks** —
  it does not expand scope.
- Steps are deliberately tiny. Resist merging two together; small steps are the point.
- **Milestones (M-numbers) are the canonical execution order.** The spec's *phases* are
  thematic groupings only; the phase↔milestone map lives in
  [`backend-spec.md`](./backend-spec.md) §15.
- **Every milestone ends with a human review gate.** The founder runs `npm run smoke`
  (the standing end-to-end test, from M6) + that milestone's human checkpoints and signs
  off **before the next milestone begins**. The ✅ notes flag the launch-critical gates (M1, M6, M7), but the
  sign-off applies to *all* milestones, M0 through M13.

## Agent guardrails (read first)

1. **Never call a real external service in code or tests.** PayHere, Google Maps and
   email are reached only through an interface (`adapters/`) with a **fake**
   implementation used everywhere except the explicit "swap to real" steps.
2. **Don't edit another step's tests** to make yours pass. If a prior test is wrong,
   stop and flag it.
3. **Keep interfaces stable.** Once a function signature is defined in a step, later
   steps depend on it. Changing it requires a dedicated step.
4. **No scope creep.** Build only what the step lists. Extra ideas → note in the PR,
   don't implement.
5. **Every step adds tests, proven.** No new behaviour ships without a test that would
   fail if the behaviour broke — and you **paste the test failing *before* your change**
   (red→green) so "a test exists" can't be gamed by an assertion-free test.
6. **Leave it green.** `npm run check` (typecheck + lint + test) must pass before PR.

---

## Fixed stack (do not substitute — consistency prevents drift)

- **Runtime:** Node 20 LTS · **Language:** TypeScript (strict)
- **HTTP:** Hono · **Validation:** Zod · **Tests:** Vitest (use Hono's `app.request()`
  for endpoint tests — no separate HTTP client)
- **DB:** Postgres (Supabase) via **Drizzle ORM**; migrations via `drizzle-kit`
- **Package manager:** npm · **Location:** `api/` folder in this repo
- **IDs:** uuid (`gen_random_uuid()`) · **Money:** integer minor units + ISO currency
- **Conventions:** `api/src/{routes,services,db,adapters,lib}`, tests colocated as
  `*.test.ts`. Config read once via a validated `config.ts`.

### Standard commands (defined in Step 0.1, used by every checkpoint)
```
npm run dev      # start API on http://localhost:8787
npm test         # run all tests once
npm run check    # typecheck + lint + test  (the gate for every PR)
npm run migrate  # apply DB migrations (from Milestone 2 on)
npm run smoke    # end-to-end pipeline smoke test (from Milestone 6 on)
```

### Test strategy
- **Unit** — pure functions (pricing stub, validation, transitions): plain Vitest.
- **HTTP** — endpoints via `app.request(...)`: assert status + JSON body shape.
- **DB integration** (Milestone 2+) — run against a **separate test database**
  (`DATABASE_URL_TEST`); each test truncates/rolls back so tests are isolated.
- **Adapters** — assert the fake was called with the right args; never hit the network.

---

## Progress tracker

_Status as of 2026-06-19 (mirrors merged work on `main`):_
- [x] M0 Foundations — 0.1 skeleton ✓, 0.2 config module ✓, 0.3 CI ✓
- [x] M1 Single transfer, in-memory (1.1–1.5) ✓
- [x] M2 Persistence — 2.1 connection ✓, 2.2 schema+migration ✓, 2.3 Postgres repos (bookings/payments/concierge) ✓, 2.4 customer persisted ✓. Server runs on Postgres; integration tests run in CI.
- [x] M3 Booking lifecycle (3.1–3.2) ✓
- [~] M4 Email, fake — 4.1 ✓, 4.2 ✓. **4.3 e-ticket PDF NOT built** (optional).
- [x] M5 Payments — 5.1–5.4 (fake) ✓. **5.5 Phase 1.5 — VERIFIED END-TO-END IN SANDBOX (2026-06-20):** PayHerePaymentAdapter (hash + md5sig) ✓; public notify URL = Render `/webhooks/payments` ✓; front-end uses the PayHere JS SDK popup (`booking.js` `startPayHere`, payhere.js in booking.html) ✓; real sandbox payment proven — CH-NDYDS went `draft → paid`, payment `succeeded`, concierge task created. **Go-live caveat: PayHere is APEX-ONLY (no subdomains, owned domains only); sandbox tested via `localhost`. Real payments require serving the site on `ceylonhop.com` apex + re-adding the 5 env vars (PAYHERE_MODE=live) — a launch step, no code change.** Deposit-vs-full charge for chauffeur (charges full now) is a small follow-up.
- [x] Customer capture (lead-traveller details) ✓
- [x] M6 Ops visibility (6.1–6.3) ✓
- [x] M7 Connect the live website — flag-gated (`window.CEYLON_HOP_API` / `?api=`; default = simulated). **All three flows verified end-to-end through the real UI → Supabase:** single `CH-5SYHS`, trip `CH-UKAUW`, shared `CH-EXNYA`. Fixed a real shared-flow bug: the backend's seeded corridors (`cmb-ella`/`cmb-galle`) did not match the frozen front-end's actual corridors, so every real shared booking 400'd (`unknown_corridor`) and silently fell back to a simulated ref. Backend now seeds the 6 front-end corridors (`departureRepo.ts`, mirrors `transfers-data.js` `CORRIDORS`) and resolves a corridor from any stop-pair via `corridorIdForRoute`; the site now passes the `corridorId` it already computes (`search.js` shared CTA → `booking.js` shared payload) so resolution is robust even when the pickup is edited. (7.2 confirmation-reads-booking + pricing reconciliation backend-vs-front-end total still open.)
- [x] M8 Google Maps (8.1–8.2) — `adapters/maps.ts` `MapsAdapter.distance(from,to)` with `FakeMapsAdapter` (haversine ×1.35 from a place table, mirrors the site; null for typed addresses) + `GoogleMapsAdapter` (Distance Matrix, config-selected via `GOOGLE_MAPS_API_KEY`). Single-transfer bookings enriched with `distance_km`/`duration_min` (migration 0006, transfer_request; best-effort, never blocks). Pricing still the stub (M11 deferred per founder). **Real-key swap pending:** add `GOOGLE_MAPS_API_KEY` (restricted to Distance Matrix) on Render for real distances; trip/shared distance enrichment also deferred.
- [x] M9 Multi-stop trips (9.1–9.6) ✓ — schema, pricing, booking model (single|trip), `POST /bookings/trip`, Postgres persistence (mode + trip_request), and the E2E smoke covers a trip. _Built ahead of M7/M8, which need a UI edit / Google key._
- [x] M10 Shared-seat bookings (10.1–10.6) ✓ — schema, pricing, inventory, endpoint, Postgres persistence (corridor/shared_departure/shared_request) with a **real-DB atomic seat-hold proven no-oversell under concurrency**, and the E2E smoke covers a shared seat.
- [ ] M11+ later milestones (outlined at the end)

> Known gaps: e-ticket PDF (4.3) not built; schema stores places as free text with no
> `updated_at`/status DB-constraint; rotate the exposed dev DB password.

---

## Milestone 0 — Foundations

### Step 0.1 — API skeleton + health endpoint
- **Goal:** a running Hono API with a test harness.
- **Depends on:** none.
- **Build:** `api/` with TypeScript + Hono + Vitest; `GET /health` → `{ "status": "ok" }`;
  npm scripts `dev`, `test`, `check`.
- **Tests:** `GET /health` returns 200 and `{status:"ok"}`.
- **Human checkpoint:** `cd api && npm run dev`, open http://localhost:8787/health →
  see `{"status":"ok"}`. `npm test` → green.
- **Done when:** checkpoint passes; `npm run check` green.

### Step 0.2 — Config module
- **Goal:** validated env access (no scattered `process.env`).
- **Depends on:** 0.1.
- **Build:** `src/config.ts` reads env via Zod (e.g. `PORT`, `NODE_ENV`); throws on
  missing required vars at boot.
- **Tests:** valid env parses; missing required var throws a clear error.
- **Human checkpoint:** delete a required var → `npm run dev` fails fast with a readable
  message; restore → starts.
- **Done when:** checkpoint passes.

### Step 0.3 — CI gate
- **Goal:** every PR is auto-checked.
- **Depends on:** 0.1.
- **Build:** GitHub Actions workflow running `npm ci && npm run check` on push/PR.
- **Tests:** n/a (the workflow *is* the test); include a trivial assertion so the suite
  isn't empty.
- **Human checkpoint:** push a branch → see the green check on GitHub.
- **Done when:** CI passes on a PR.

---

## Milestone 1 — Single transfer booking (in-memory; no Google, no PayHere)

This is the simplest end-to-end slice: take a single-transfer request over HTTP and
return a created booking — no database, no external services.

### Step 1.1 — Single-transfer request schema + types
- **Goal:** a typed, validated shape for a single-transfer booking request.
- **Depends on:** 0.1.
- **Build:** `src/domain/singleTransfer.ts` — Zod schema `SingleTransferInput`
  (`from`, `to`, `date?`, `time?`, `vehicleType` car|van, `adults`≥1, `children`≥0,
  `bags`≥0) + inferred TS type.
- **Tests:** accepts a valid object; rejects missing `from`/`to`, `adults` < 1,
  negative `bags`, bad `vehicleType`.
- **Human checkpoint:** `npm test` green (this step is pure logic).
- **Done when:** all schema tests pass.

### Step 1.2 — Stub pricing
- **Goal:** a deterministic placeholder price (real engine comes much later).
- **Depends on:** 1.1.
- **Build:** `src/services/pricing.ts` — `quoteSingleTransfer(input): { currency, total }`
  returning a **fixed dummy rule** (e.g. base 4000¢ + 1000¢/extra adult; van +2000¢),
  USD, in cents. Add a `// TODO: replace with real engine (spec §6)` marker.
- **Tests:** known inputs → exact expected totals; deterministic (same input twice =
  same output).
- **Human checkpoint:** `npm test` green.
- **Done when:** pricing tests pass.

### Step 1.3 — Booking repository interface + in-memory store
- **Goal:** a storage seam so we can swap to Postgres later without touching routes.
- **Depends on:** 1.1.
- **Build:** `src/db/bookingRepo.ts` — interface `BookingRepo { create(b), get(id) }`
  + `InMemoryBookingRepo`. Booking shape includes `id`, `reference` (e.g. `CH-XXXXX`),
  `status: "draft"`, the transfer input, and `total`/`currency`.
- **Tests:** create returns a booking with a unique id + reference; get returns it; get
  unknown id returns null.
- **Human checkpoint:** `npm test` green.
- **Done when:** repo tests pass.

### Step 1.4 — `POST /bookings/single`
- **Goal:** create a single-transfer draft over HTTP.
- **Depends on:** 1.1, 1.2, 1.3.
- **Build:** route validates body with `SingleTransferInput`, calls
  `quoteSingleTransfer`, creates a draft via `BookingRepo`, returns **201** with
  `{ id, reference, status, total, currency, ... }`. Invalid body → **400** with field
  errors. **Accept an `Idempotency-Key` header** — a repeat with the same key returns the
  **same** booking (200), never a duplicate draft.
- **Tests:** valid body → 201 + correct shape + total matches stub; invalid body → 400
  with error details; **same `Idempotency-Key` twice → one booking (second call returns
  it, no duplicate).**
- **Human checkpoint:**
  ```
  curl -s -X POST localhost:8787/bookings/single \
    -H 'content-type: application/json' \
    -d '{"from":"Colombo Airport","to":"Ella","vehicleType":"car","adults":2,"children":0,"bags":2}'
  ```
  → 201 JSON with a `reference` and a `total`.
- **Done when:** checkpoint returns a created booking; tests green.

### Step 1.5 — `GET /bookings/:id`
- **Goal:** read a booking back.
- **Depends on:** 1.4.
- **Build:** route returns the booking JSON or **404**.
- **Tests:** create-then-get round-trip returns same booking; unknown id → 404.
- **Human checkpoint:** create one (1.4), copy its `id`, `curl localhost:8787/bookings/<id>`
  → same booking; random id → 404.
- **Done when:** checkpoint passes; tests green.

> ✅ **Milestone 1 review:** you can book a single transfer and read it back, fully
> tested, with zero external dependencies. This is the template every later feature copies.

---

## Milestone 2 — Persistence (Postgres / Supabase)

### Step 2.1 — DB connection + Drizzle setup
- **Goal:** the API can talk to Postgres.
- **Depends on:** 0.2.
- **Build:** Drizzle + `postgres` driver; `DATABASE_URL` / `DATABASE_URL_TEST` in config;
  `src/db/client.ts`; `npm run migrate` script.
- **Tests:** a connection test that runs `select 1` against `DATABASE_URL_TEST`.
- **Human checkpoint:** create a free Supabase project, put its connection string in
  `.env`, `npm run migrate` (no-op ok) connects without error.
- **Done when:** test DB connects in CI and locally.
- **Cost note:** the Supabase **free** tier is plenty for the entire build + dev/test
  (500 MB DB ≈ decades of bookings at your volume). But the free tier has **no backups**
  and pauses after 7 days idle — so when the **production** project goes live with real
  bookings/payments, move it to **Pro (~$25/mo)** for daily backups + no auto-pause.

### Step 2.2 — `customers` + `bookings` (+ `transfer_request`) migration
- **Goal:** schema for a persisted single-transfer booking.
- **Depends on:** 2.1.
- **Build:** Drizzle migration creating `customers`, `bookings`, `transfer_request`
  (subset of spec §5 needed for single transfer). uuid PKs, timestamps, status enum.
- **Tests:** migration applies cleanly on the test DB; can insert + select a `bookings`
  row (repo-less raw test).
- **Human checkpoint:** `npm run migrate`, then open Supabase → Table editor → see the
  three tables.
- **Done when:** tables exist; insert/select test passes.

### Step 2.3 — Postgres repository (swap behind the interface)
- **Goal:** persist bookings for real, without changing routes.
- **Depends on:** 1.3, 2.2.
- **Build:** `PostgresBookingRepo` implementing `BookingRepo`; wire the app to use it
  (in-memory stays for unit tests). DB integration tests use `DATABASE_URL_TEST`.
- **Tests:** the **same** create/get assertions from Step 1.3/1.5 pass against Postgres;
  data survives a re-read (new repo instance).
- **Human checkpoint:** `POST /bookings/single` (1.4 curl), then Supabase → see the new
  row; restart the API and `GET` it → still there.
- **Done when:** booking persists across restarts; tests green.

### Step 2.4 — Capture customer details
- **Goal:** store who's booking.
- **Depends on:** 2.3.
- **Build:** extend `SingleTransferInput` with `customer { name, email, whatsapp, country }`
  (validated); persist a `customers` row linked to the booking.
- **Tests:** booking with customer persists + links; missing/invalid email → 400.
- **Human checkpoint:** book with a customer block → Supabase shows linked customer +
  booking rows.
- **Done when:** customer is stored and linked; tests green.

---

## Milestone 3 — Booking lifecycle

### Step 3.1 — Status enum + transition guard
- **Goal:** enforce legal status changes (spec §7).
- **Depends on:** 2.2.
- **Build:** `src/domain/status.ts` — statuses + `canTransition(from,to)` +
  `transition(booking,to)` that throws on illegal moves.
- **Tests:** `draft→payment_pending` allowed; `draft→completed` rejected; terminal
  states reject further moves.
- **Human checkpoint:** `npm test` green.
- **Done when:** transition tests pass.

### Step 3.2 — Persist transitions
- **Goal:** a booking's status can change and is saved.
- **Depends on:** 3.1, 2.3.
- **Build:** repo method `setStatus(id,to)` using the guard; an internal service call
  (no public endpoint yet).
- **Tests:** legal transition updates the row; illegal one leaves it unchanged + errors.
- **Human checkpoint:** via a temporary test script or admin call, move a booking to
  `payment_pending` → Supabase reflects it.
- **Done when:** persisted transitions work; tests green.

---

## Milestone 4 — Email confirmation (fake adapter, manual trigger)

### Step 4.1 — Email adapter interface + fake
- **Goal:** a swappable email seam.
- **Depends on:** 0.1.
- **Build:** `adapters/email.ts` — `EmailAdapter { send(msg) }` + `FakeEmailAdapter`
  that records sent messages in memory.
- **Tests:** fake records the message; returns success.
- **Human checkpoint:** `npm test` green.
- **Done when:** fake adapter tested.

### Step 4.2 — Compose booking confirmation
- **Goal:** a correct confirmation email for a booking.
- **Depends on:** 4.1, 2.4.
- **Build:** `services/notifications.ts` — `sendBookingConfirmation(booking)` builds
  subject/recipient/HTML and calls the adapter.
- **Tests:** recipient = customer email; subject/body include reference, route, total
  (snapshot test); adapter called exactly once.
- **Human checkpoint:** run the unit test; inspect the snapshot to read the email copy.
- **Done when:** composition tests pass.

### Step 4.3 — e-ticket PDF (basic)  *(optional — may defer to a later milestone)*
- **Goal:** attach a simple boarding-pass PDF.
- **Depends on:** 4.2.
- **Build:** generate a minimal PDF (reference, route, date, pax) and attach it.
- **Tests:** a PDF buffer is produced and attached; filename includes reference.
- **Human checkpoint:** save the generated PDF from a test fixture and open it.
- **Done when:** PDF attaches; tests pass. *(Skip/park if you'd rather move faster.)*

---

## Milestone 5 — PayHere (fake first, then sandbox)

> **Phase 1 is steps 5.1–5.4 only** — the whole flow runs on the **fake** adapter, with
> a *simulated* webhook. **Phase 1 needs zero real PayHere wiring.** Step 5.5 (wiring the
> real PayHere keys) is **Phase 1.5**, done only **after** the full pipeline is verified
> end-to-end on the fake (post-M6).

### Step 5.1 — Payment adapter interface + fake
- **Goal:** a swappable payment seam.
- **Depends on:** 0.1.
- **Build:** `adapters/payments.ts` — `PaymentAdapter { createCheckout(booking) }`
  returning checkout params; `FakePaymentAdapter` returns deterministic fake params +
  exposes a `simulateWebhook(bookingId, status)` helper for tests.
- **Tests:** fake returns expected params; helper builds a valid webhook payload.
- **Human checkpoint:** `npm test` green.
- **Done when:** fake adapter tested.

### Step 5.2 — `POST /bookings/:id/checkout`
- **Goal:** start payment for a booking.
- **Depends on:** 5.1, 3.2.
- **Build:** create a `payment` row (`pending`, with `idempotency_key`), move booking to
  `payment_pending`, return checkout params from the adapter. **Assert the checkout amount
  equals the booking's `amount_due_now`** (re-derived from the stored total + `pay_plan`);
  reject on mismatch — never charge an amount that disagrees with the booking.
- **Tests:** returns params; payment row created; status moved; unknown booking → 404;
  **checkout amount == stored `amount_due_now`, and a tampered/mismatched amount → rejected.**
- **Human checkpoint:** `POST /bookings/<id>/checkout` → JSON checkout params; Supabase
  shows a pending payment.
- **Done when:** checkpoint passes; tests green.

### Step 5.3 — `POST /webhooks/payhere` (fake-signed)
- **Goal:** mark a booking paid when payment succeeds — safely and idempotently.
- **Depends on:** 5.2.
- **Build:** verify signature (helper), mark payment `succeeded`, transition booking to
  `paid`; **idempotent** on `idempotency_key`; bad signature → 401.
- **Tests:** valid webhook → booking `paid` + payment `succeeded`; **duplicate webhook →
  no double transition / no duplicate payment**; bad signature → 401.
- **Human checkpoint:** use the fake `simulateWebhook` via a script → booking flips to
  `paid` in Supabase; run it twice → still single payment.
- **Done when:** all three test cases pass; checkpoint confirms idempotency.

### Step 5.4 — Send confirmation on `paid`
- **Goal:** wire email into the paid transition.
- **Depends on:** 5.3, 4.2.
- **Build:** on transition to `paid`, call `sendBookingConfirmation` (via fake email
  adapter in tests/dev).
- **Tests:** paid transition triggers exactly one confirmation; non-paid transitions
  don't.
- **Human checkpoint:** simulate a paid webhook → fake email log (printed in dev) shows
  the confirmation to the customer's address.
- **Done when:** email fires on paid; tests green.

### Step 5.5 — Swap fake → real PayHere **sandbox**  *(Phase 1.5 — not Phase 1)*
- **Goal:** a real (sandbox) payment drives the flow end-to-end.
- **Depends on:** 5.4.
- **Build:** `PayHerePaymentAdapter` using your **existing keys** (sandbox mode);
  configure the **notify/webhook URL**; verify the real signature format. Keep the fake
  for tests — only dev/prod use the real adapter (selected by config).
- **Tests:** unit-test the real signature verification with a captured sample payload
  (still no network in tests).
- **Human checkpoint (big one):** from a temporary test page or curl-built checkout,
  complete a **sandbox** PayHere payment → the booking becomes `paid` in Supabase and
  the confirmation email is sent.
- **Done when:** a real sandbox payment produces a paid booking + email.

---

## Milestone 6 — Ops visibility (so staff can run it manually)

Staff act on the **real Postgres data** — no separate mirror or copy. See the ops-tool
note below the steps.

### Step 6.1 — Concierge task on `paid`
- **Build:** create a `concierge_task` (`confirm_pickup`) row when a booking becomes
  paid. **Tests:** one task per paid booking; none for unpaid. **Checkpoint:** Supabase
  shows the task. **Depends on:** 5.3.

### Step 6.2 — Admin list endpoint (simple API-key auth)
- **Build:** `GET /admin/bookings` (filter by status), guarded by an `ADMIN_API_KEY`
  header (Supabase Auth/RBAC comes in a later milestone). **Tests:** wrong/no key → 401;
  valid key → list. **Checkpoint:** curl with the key → JSON list of bookings.
  **Depends on:** 2.3.

### Step 6.3 — End-to-end smoke test (the Phase-1 pipeline)
- **Build:** `npm run smoke` — one test that drives the **whole stub pipeline**:
  `POST /bookings/single` → `POST /bookings/:id/checkout` → simulate the PayHere webhook →
  assert the booking is `paid`, a confirmation email was sent (fake adapter), a
  `confirm_pickup` task exists, and `GET /admin/bookings` lists it. Runs in CI.
- **Tests:** the smoke *is* the test; it must fail if **any** stage of the pipeline breaks
  (not just one unit).
- **Human checkpoint:** `npm run smoke` → green. This is the script you re-run at **every
  later milestone gate**. **Depends on:** 5.4, 6.1, 6.2.
- **Note:** the smoke **grows** as milestones add capability — each new booking type
  (multi-stop M9, shared M10) and real PayHere (5.5) extends it.

> **Ops tool — configuration, not a build step.** Staff read/triage bookings directly on
> the Postgres data:
> - **Now (tiny volume):** Supabase **Table Editor** — free, already there, zero setup.
> - **Within ~6 months (manual ops grows):** put **NocoDB** (open-source, free,
>   Airtable-like grid/kanban; unlimited users/records self-hosted) or **Retool**
>   (free tier = **up to 5 users**, custom dashboard + action buttons; granular RBAC
>   and audit logging are **paid**) **directly on the same Postgres** — no data
>   duplication, no sync. Booking volume doesn't affect either free tier.
> - *Avoid Airtable* — free tier caps at 1,000 records/base and is a second copy to sync.

> ✅ **Milestone 6 review (end of Phase 1):** a **simulated** payment creates a paid
> booking, emails the customer, files a concierge task, and is visible to staff in
> Supabase (and any DB-connected ops tool) — all on the **stub**, no real PayHere yet.
> Your team runs WhatsApp, dispatch and refunds manually. **Real PayHere (Step 5.5) is
> next, in Phase 1.5.**

---

## Milestone 7 — Connect the live website

### Step 7.1 — Point the booking form at the API (behind a flag)
- **Build:** the site's single-transfer flow calls `POST /bookings/single`; a config
  flag keeps the old simulated path as fallback. **Tests:** a small front-end test (or
  a documented manual script) that the form posts the right payload. **Checkpoint:** on
  staging, submit the form → a draft appears in Supabase. **Depends on:** 1.4, 2.4.

### Step 7.2 — Real checkout + confirmation page
- **Build:** site redirects to the PayHere checkout from Step 5.2/5.5; the confirmation
  page reads `GET /bookings/:id`. **Tests:** confirmation page renders a paid booking
  (component/manual). **Checkpoint:** on staging, complete a sandbox payment → land on a
  real confirmation page showing the booking. **Depends on:** 5.5, 1.5.

### Step 7.3 — End-to-end on staging
- **Build:** none (verification step). **Checkpoint:** a full run on the staging site:
  search → book single transfer → sandbox pay → paid booking + email + visible to staff
  in Supabase / the ops tool. **Depends on:** 7.2, 6.2.

> ✅ **This is the launch-readiness gate for single transfers** (switch PayHere to live
> only after this passes on staging).

---

## Milestone 8 — Google Maps (intentionally deferred to here)

### Step 8.1 — Maps adapter interface + fake
- **Build:** `adapters/maps.ts` — `MapsAdapter { distance(from,to) }` + fake returning a
  fixed distance/duration. **Tests:** fake returns expected. **Checkpoint:** `npm test`.
  **Depends on:** 0.1.

### Step 8.2 — Enrich bookings with distance (+ real key)
- **Build:** call the maps adapter when creating a booking to store `distance_km`/
  `duration_min`; add the real Google adapter (config-selected, key restricted).
  Pricing stays the stub. **Tests:** booking stores distance from the fake.
  **Checkpoint:** book a transfer → distance populated; with the real key on staging,
  a real distance is stored. **Depends on:** 2.4.

---

## Later milestones (same ticket format — expanded just-in-time)

These follow the identical pattern (interface + fake → real, tests + checkpoint per
step). They're outlined, not yet broken into tickets, because details depend on
decisions still open (e.g. the real pricing model, driver model). Expand each into
1.x-style steps when you reach it.

- **M9 — Multi-stop trips + tour hand-off.** The natural extension of single transfer —
  reuses the whole Phase-1 pipeline (persistence, stubbed payment, email, ops). Sub-steps:
  - **9.1** `TripInput` schema (stops, nights, dates, pax, vehicle, serviceType, customer).
  - **9.2** `quoteTrip` stub pricing (per-leg private; per-day chauffeur).
  - **9.3** Lift `customer` to the booking top level + add `mode`; `Booking` becomes a
    `single | trip` shape (in-memory first; keep single-transfer green).
  - **9.4** `POST /bookings/trip` (validate → quoteTrip → trip draft), in-memory.
  - **9.5** Persist trips: `itinerary`/`leg`/`stay` tables + Postgres support + integration test.
  - **9.6** Trip-aware confirmation email; extend the E2E smoke with a trip.
- **M10 — Shared-seat bookings + inventory.** New mechanic: fixed corridors/departures
  with an **atomic seat-hold** (no oversell). Sub-steps:
  - **10.1** `SharedInput` schema (corridor, date, time, seats, customer).
  - **10.2** `quoteShared` stub (seats × corridor seat price).
  - **10.3** Corridor + SharedDeparture (in-memory) with atomic `holdSeats` + concurrency test.
  - **10.4** Add `shared` to the booking union; `POST /bookings/shared` (resolve corridor →
    quote → hold seats → booking; **409 on oversell**), in-memory.
  - **10.5** Persist: `corridor` + `shared_departure` tables + Postgres atomic hold
    (`UPDATE … WHERE seats_booked + n <= seats_total`) + integration/concurrency test.
  - **10.6** Extend the E2E smoke with a shared booking.
- **M11 — Authoritative pricing engine + `rate_card`.** Replace the stub behind the same
  function signatures; parity test asserts site = booking = charge.
- **M12 — Ops dashboard (custom UI).** Graduate from NocoDB/Retool to a bespoke staff
  dashboard; Supabase Auth + RBAC roles.
- **M13 — WhatsApp Business API (fast follow).** Add a `WhatsAppAdapter`; auto-send
  confirmations/reminders; team inbox.
- **M14 — Reminders, review requests, SLA timers.** Scheduled jobs + concierge SLA on
  SL hours.
- **M15 — Reporting / CSV export.** Payments + bookings export until accounting lands.
- **M16 — SEO-safe site migration.** Replacing the current `ceylonhop.com` site with the
  new booking site is **not like-for-like**: the live site ranks via per-route landing pages
  (`/trip/<from>-to-<to>/`) the new app-style site doesn't have. Recreate static route pages
  (from corridor/`REAL_KM` data), 301-map the old URLs, and ship the missing
  `sitemap.xml`/`robots.txt`/`404.html`/`CNAME` + sitewide canonical/OG + structured data
  before the apex cutover. **Full analysis + action plan: [`seo-migration-plan.md`](./seo-migration-plan.md).**
- **M17 — Observability & alerting.** Production today has **no error tracking, uptime alerting,
  or payment-failure alerts** — just `console.error` to ephemeral Render logs. For a payments
  business that's the main launch risk. Right-sized plan (Sentry + uptime monitor + a payments
  watchdog for webhook failures / stuck `payment_pending` / paid-without-confirmation, alerting to
  WhatsApp/Slack). **Strongly recommended before taking real payments. Full plan:
  [`observability-plan.md`](./observability-plan.md).**

---

## Hardening backlog (address before broad autonomy)

Known gaps deferred from the v1 critique — fold into the relevant step or do as a small
pass; don't let them block the first slices, but don't ship to production without them:

- **Test quality, not just presence.** Each new test must *fail* if its behaviour is
  reverted (negative check / light mutation). Consider a coverage floor in CI so "a test
  exists" can't be gamed by an assertion-free test.
- **Rollback policy.** Migrations are forward-only; document the revert procedure for a
  bad merged step (and a migration-down where safe). The Reviewer checks this for
  schema-touching steps.
- **Reference-code uniqueness.** `CH-XXXXX` generated with a DB unique constraint +
  retry-on-collision, not just random (Step 1.3 / 2.2).
- **`updated_at` maintenance.** Maintained by a DB trigger (or ORM hook) and verified by
  a test — not assumed.
- **Auth migration path.** The interim `ADMIN_API_KEY` (Step 6.2) is replaced by Supabase
  Auth + RBAC + row-level security in **M12**; don't bake the API-key assumption deep.
- **Test isolation.** CI provisions an **ephemeral Postgres per run**
  (`.github/workflows/ci.yml`), so parallel PRs don't stomp a shared test DB; locally use
  `DATABASE_URL_TEST` and truncate between tests.

### From the pre-M7 audit (2026-06-19)
- **Pricing — REVISED 2026-06-19: store the quoted price (spec §0.3).** The earlier
  "ignore client price, use the stub" decision created a real mismatch (site showed $70,
  DB stored a $50 stub). Now the site sends `quotedTotal` (minor units = the price the
  customer was shown) and the API records it; the stub (`quoteSingleTransfer`/`quoteTrip`/
  `quoteShared`) is only a fallback when `quotedTotal` is absent (API-only callers/tests).
  `quotedTotal` is bounded ($1–$1M) to reject tampering; bookings are still manually
  confirmed before charging, and writes are rate-limited. The **authoritative** server-side
  engine (real rate_card + Google distances for typed addresses) is still M11; this just
  makes confirmation = DB = charge agree today.
- **Shared seat-hold leak.** The `/bookings/shared` route holds seats (committed) then
  creates the booking in a *separate* transaction; if create fails, seats are held with no
  booking. Make hold + create one transaction (or compensate on failure).
- **Rate limiting — DONE 2026-06-19.** Per-IP sliding-window limiter (`lib/rateLimit.ts`)
  on `/bookings/*` POSTs (default 20/min/IP, configurable via `RATE_LIMIT_MAX`/`_WINDOW_MS`);
  429 + `Retry-After`. Webhooks/reads unaffected.
- **Tighten CORS — DONE 2026-06-19.** Allow-list via `ALLOWED_ORIGINS` (live site + local
  dev) instead of `*`; unknown origins get no `Access-Control-Allow-Origin`. Server-to-server
  callers (PayHere webhook) send no Origin and are unaffected.

### Deployment + reliability (2026-06-19)
- **Backend deployed** to Render free Web Service → `https://ceylon-hop-api.onrender.com`;
  `booking.html` defaults the API flag to it (override `?api=<url>` / `?api=off`).
- **Customer name split** into `first_name` + `last_name` columns (migration 0004);
  `CustomerInput` now takes `firstName`/`lastName`; checkout no longer string-splits a name.
- **No more fake confirmations.** When a backend is configured, a failed save now throws
  (30s timeout) and the flow shows a retry error instead of a simulated `CH-XXXXX-YYYY` ref.
- **Keep-alive** (`.github/workflows/keepalive.yml`) pings `/health` every 13 min so the
  free instance doesn't cold-start. Free-tier still sleeps if the schedule lapses; upgrade
  off free before launch.
- **Fixed (earlier audit):** CORS enabled (M7 unblock) + a global JSON error handler.

---

## Definition-of-done checklist (paste into every PR)

- [ ] Built only what the step lists; no out-of-scope changes
- [ ] Tests added for the new behaviour (and they fail if it regresses)
- [ ] Red→green evidence pasted — the new test failing *before* the change, passing after
- [ ] `npm run check` green (typecheck + lint + test)
- [ ] `npm run smoke` still green (from M6 on)
- [ ] Human checkpoint performed and passed (paste the output/screenshot)
- [ ] No real external service called in code or tests (except the explicit swap steps)
- [ ] Interfaces unchanged (or change is the whole point of this step)
