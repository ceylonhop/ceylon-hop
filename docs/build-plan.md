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
- **Every milestone ends with a human review gate.** The founder runs that milestone's
  human checkpoints + a quick end-to-end smoke test and signs off **before the next
  milestone begins**. The ✅ notes flag the launch-critical gates (M1, M6, M7), but the
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
5. **Every step adds tests.** No new behaviour ships without a test that would fail if
   the behaviour broke.
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
```

### Test strategy
- **Unit** — pure functions (pricing stub, validation, transitions): plain Vitest.
- **HTTP** — endpoints via `app.request(...)`: assert status + JSON body shape.
- **DB integration** (Milestone 2+) — run against a **separate test database**
  (`DATABASE_URL_TEST`); each test truncates/rolls back so tests are isolated.
- **Adapters** — assert the fake was called with the right args; never hit the network.

---

## Progress tracker

- [ ] M0 Foundations (0.1–0.3)
- [ ] M1 Single transfer, in-memory (1.1–1.5)
- [ ] M2 Persistence (2.1–2.4)
- [ ] M3 Booking lifecycle (3.1–3.2)
- [ ] M4 Email, fake (4.1–4.3)
- [ ] M5 PayHere (5.1–5.5)
- [ ] M6 Ops visibility (6.1–6.2)
- [ ] M7 Connect the live website (7.1–7.3)
- [ ] M8 Google Maps (8.1–8.2)
- [ ] M9+ later milestones (outlined at the end)

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
  errors.
- **Tests:** valid body → 201 + correct shape + total matches stub; invalid body → 400
  with error details.
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
  `payment_pending`, return checkout params from the adapter.
- **Tests:** returns params; payment row created; status moved; unknown booking → 404.
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
  reuses the whole Phase-1 pipeline (persistence, stubbed payment, email, ops) and only
  adds the itinerary shape. Persist `itinerary`/`leg`/`stay`; accept the planner/tour
  payload (stops, nights, dates, service type: private vs chauffeur); price via stub.
  No new concurrency.
- **M10 — Shared-seat bookings + inventory.** Built last of the three because it adds
  genuinely new mechanics: `corridor` + `shared_departure` with an **atomic seat-hold**
  (no oversell) plus a concurrency test that hammers the same departure. Reuses the
  M1–M2 booking/persistence foundations for `mode=shared`.
- **M11 — Authoritative pricing engine + `rate_card`.** Replace the stub behind the same
  function signatures; parity test asserts site = booking = charge.
- **M12 — Ops dashboard (custom UI).** Graduate from NocoDB/Retool to a bespoke staff
  dashboard; Supabase Auth + RBAC roles.
- **M13 — WhatsApp Business API (fast follow).** Add a `WhatsAppAdapter`; auto-send
  confirmations/reminders; team inbox.
- **M14 — Reminders, review requests, SLA timers.** Scheduled jobs + concierge SLA on
  SL hours.
- **M15 — Reporting / CSV export.** Payments + bookings export until accounting lands.

---

## Definition-of-done checklist (paste into every PR)

- [ ] Built only what the step lists; no out-of-scope changes
- [ ] Tests added for the new behaviour (and they fail if it regresses)
- [ ] `npm run check` green (typecheck + lint + test)
- [ ] Human checkpoint performed and passed (paste the output/screenshot)
- [ ] No real external service called in code or tests (except the explicit swap steps)
- [ ] Interfaces unchanged (or change is the whole point of this step)
