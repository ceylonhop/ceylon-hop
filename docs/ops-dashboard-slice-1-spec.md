# Ceylon Hop Ops Dashboard — Slice 1: Daily Control Tower (Spec)

_Status: approved design, ready to plan. 2026-06-21._

A bespoke internal dashboard that helps the Ceylon Hop team **run website bookings
day-to-day**. This spec covers **Slice 1** only; later slices are listed at the end.

---

## 1. Operating context (the reality we design for)

- Ceylon Hop sells **shared rides, single transfers, and multi-stop trips** through the
  website. The website owns the booking data model; the dashboard sits **on top of it**.
- **No owned fleet, no direct/contracted drivers.** Rides are fulfilled through **travel
  coordinators** who each run a private WhatsApp group of trusted drivers. Ceylon Hop sends
  the day's ride list to a coordinator; the coordinator assigns a vehicle and confirms back.
- Ceylon Hop usually gets **vehicle confirmation (and a photo) from the coordinator**, not a
  driver profile or number. → **coordinator-first**, not driver-first.
- **No WhatsApp Business API.** Comms happen via the WhatsApp app across a few devices. The
  dashboard supports this with **copy-ready templates + `wa.me` deep links + "sent" tracking**
  — never assumes automated sending.
- **Ops and finance are separated by role.** Support/ops staff run rides; revenue / profit /
  margin reports are scoped to founder/finance users.
- **Phase one is website bookings only** — no agent-created bookings or payment links yet.

## 2. Goal of Slice 1

A **daily control tower** for website bookings: see who's travelling, find any booking,
assign rides to coordinators, generate the WhatsApp ride list, and track fulfilment so the
team never forgets a booking or misses a coordinator follow-up.

## 3. Scope

**In Slice 1:**
1. **All Bookings** view — every website booking (shared/single/trip) unified in one
   searchable, filterable list, incl. payment status.
2. **Daily Control Tower** — today/tomorrow rides, fulfilment-focused.
3. **Ops-layer data model** — new tables referencing read-only website bookings.
4. **Coordinator management + assignment.**
5. **WhatsApp manifest generator** (copy-ready ride list) + sent/ack tracking.
6. **Per-ride fulfilment status** (the coordinator workflow).
7. **Booking detail view** (read-only facts + ops actions).
8. **Auth + the role boundary** (support vs founder), with revenue endpoints gated from day one.

**Out of Slice 1 (later slices):** comms template library & message checklists · risk/alerts
engine · issue tracking · ops tasks/reminders · founder finance *screen* (revenue/profit/
margins/exports) · per-user accounts + full RBAC (Supabase Auth) · agent-created bookings ·
storing vehicle photo files.

## 4. Architecture

- **Served by the API (Hono) at `/ops`** — a self-contained internal app (vanilla HTML + JS),
  same-origin as the JSON endpoints. Keeps the admin UI **off the frozen marketing site**
  (per the build contract — the UI lives under `api/`, not the root site), avoids CORS +
  tokens-in-public-JS, and ships in the one Render deploy.
- **Two layers, cleanly separated:**
  - **Website booking model = read-only source of truth.** We never mutate `bookings`,
    `transfer_request`, `trip_request`, `shared_request`, `payments`, `customers`.
  - **Ops layer = new tables that reference bookings by id.** (Rejected: adding columns to the
    booking tables — pollutes the website model; a JSON blob — unqueryable for board/filtering.)
- Stack unchanged: Node 20 · TS strict · Hono · Zod · Drizzle + Postgres (Supabase) · Vitest.

## 5. Ops-layer data model (new tables)

- **`coordinators`** — `id`, `name`, `whatsapp`, `regions` (text/notes), `active`, `createdAt`.
- **`ride_ops`** — one row per booking (`bookingId` unique FK):
  - `coordinatorId?` (FK, nullable)
  - `fulfilmentStatus` (enum, see §6)
  - `vehiclePhotoReceived` (bool — a checkbox, **no file stored**)
  - `customerUpdated` (bool)
  - `opsNotes` (text, nullable)
  - timestamps: `assignedAt?`, `sentAt?`, `acknowledgedAt?`, `vehicleConfirmedAt?`, `updatedAt`
  - Created lazily on first ops action, or backfilled for existing bookings.
- **`staff_users`** (auth/roles) — minimal for Slice 1, see §8.

The booking tables are untouched.

## 6. Status model — two axes

- **Booking lifecycle** (from the website, **read-only**): `draft → payment_pending →
  awaiting_details → paid → confirmed → in_progress → completed`, + `cancelled`/`refunded`/
  `no_show`. Commercial state; the dashboard displays it, never sets it (Slice 1).
- **Ride fulfilment** (ops layer, the dashboard owns it):
  `unassigned → assigned → sent_to_coordinator → acknowledged → vehicle_confirmed →
  customer_updated → completed`.
  ("Awaiting vehicle confirmation" is implicit = `acknowledged` but not yet `vehicle_confirmed`.)
  Transitions are guarded (no skipping backwards illegally); `vehiclePhotoReceived` and
  `customerUpdated` are independent toggles.

"**Needs action**" on the board is **derived** from (fulfilment status + travel date/time +
payment status), not stored.

## 7. Views

### 7.1 All Bookings (support/lookup)
Every website booking, **all modes unified**, searchable (ref / customer name / email) and
filterable (status, mode, date range). Columns: ref · customer · route (`from→to` / corridor /
stops) · travel date/time · mode badge · **booking status** · **payment status** (paid /
unpaid / partial) · fulfilment status · coordinator. Row → booking detail. Support sees the
**booking's own amount** here (what that customer paid); **aggregate revenue/profit is not on
this screen**.

### 7.2 Daily Control Tower (operations)
Today / Tomorrow (+ date picker). Bookings selected by travel date across modes (single →
`transfer_request.travel_date`; shared → `shared_request.date`; trip → `dates[]`). **Shared
rides grouped** by corridor·date·time; private/trip shown individually, clearly labelled. Per
row: ref · customer first name · route · pickup time · pax · mode · **fulfilment status** ·
coordinator · photo ✓ · customer-updated ✓ · basic risk cue (e.g. "no coordinator", "not
sent"). Payment shown as status only on this operational view.

### 7.3 Booking detail
Read-only booking facts: customer (name, **`wa.me` WhatsApp deep-link**, email, country),
trip (route/stops, date/time, vehicle, pax, bags, distance if present), payment **status** +
amount. Ops actions: assign coordinator · set fulfilment status · toggle photo-received /
customer-updated · edit ops notes.

## 8. Auth & roles

- **Two roles:** `support` (ops/support agents) and `founder` (founder/finance).
- **Slice 1 auth:** a login form exchanges a **per-role access key** for a **signed,
  role-bearing httpOnly session cookie**. Admin/ops JSON endpoints require a valid session;
  the existing `x-admin-key` header stays for CLI. Login attempts rate-limited.
- **Role boundary (enforced now):**
  - `support` → All Bookings + Daily Control Tower + booking detail + per-booking payment
    status & amount. **No** revenue/profit/margin.
  - `founder` → everything `support` sees **plus** (later slice) the finance screen.
  - **Any revenue/profit/aggregate-finance endpoint requires `founder`** — gated from day one,
    even though the finance *screen* is a later slice, so nothing leaks when it lands.
- **Upgrade path (later slice):** per-user accounts + Supabase Auth + full RBAC + audit
  (`changed_by`). `staff_users` in Slice 1 is intentionally minimal.

_Assumption to confirm in review: per-**role** keys are acceptable for Slice 1 (vs per-user
accounts now). Per-user identity/audit is deferred to the RBAC slice._

## 9. Payment / finance visibility rule

- **Support sees:** payment **status** (paid/unpaid/partial) everywhere, and the **individual
  booking's amount** on the booking detail / All Bookings (needed to answer customer queries).
- **Founder-only:** **aggregate** revenue, profit, margin, route profitability, financial
  reports/exports — these live on the founder finance screen (a later slice) behind the role
  gate. No aggregate-finance figures anywhere in the support surface.

## 10. WhatsApp manifest workflow

- Assign one or more rides to a coordinator (sets `coordinatorId`, status → `assigned`).
- **Generate manifest:** pick coordinator + date → server returns a **WhatsApp-formatted text**
  of their assigned rides — pickup time, pickup place, drop-off, pax, special/ops notes,
  customer first name. **Never money.** Copy-to-clipboard in the UI.
- **Mark sent** → stamps `sentAt` on those rides, status → `sent_to_coordinator`.
- One-tap updates for `acknowledged` and `vehicle_confirmed`; `customerUpdated` toggle.

## 11. Backend endpoints (auth-gated; support unless noted)

- `POST /ops/login`, `POST /ops/logout` — session cookie.
- `GET /ops/*` — the internal HTML/JS app.
- `GET /admin/bookings` — All Bookings: filters (status, mode, date range) + search; joins a
  `ride_ops` summary + payment status; includes per-booking amount.
- `GET /admin/rides?date=today|tomorrow|YYYY-MM-DD` — Daily Control Tower (shared grouped).
- `GET /admin/bookings/:id` — detail (booking facts + payments + `ride_ops`).
- `POST /admin/rides/:bookingId/assign` — set coordinator.
- `POST /admin/rides/:bookingId/status` — guarded fulfilment transition.
- `POST /admin/rides/:bookingId/flags` — toggle photo-received / customer-updated / notes.
- `GET /admin/coordinators`, `POST /admin/coordinators` — manage coordinators.
- `GET /admin/manifest?coordinatorId=&date=` — generate manifest text; `POST /admin/manifest/sent` — mark sent.
- (Reserved, `founder`-gated, **not built in Slice 1**): `/admin/finance/*`.

## 12. Testing (Vitest, red→green per the contract)

- `ride_ops` repo: create/get/assign, guarded status transitions (illegal → rejected), flag toggles.
- `coordinators` repo: CRUD.
- All Bookings query: correct cross-mode joins, filters/search, **no aggregate-revenue leak**.
- Daily rides query: date selection across modes, shared grouping.
- Manifest: formatting/grouping correct, **excludes money**, mark-sent stamps status.
- Auth: endpoints 401 without a session; **revenue/finance endpoints require `founder`** (403 for `support`).

## 13. Later slices (sequence)

1. **Comms templates & message checklists** (pickup, vehicle update, delay, post-ride, review…).
2. **Risk flags & alerts engine** (no coordinator today, not sent tomorrow, photo missing,
   customer not contacted, airport timing, active-but-not-completed…).
3. **Issue tracking** (type, priority, owner, status, resolution, customer follow-up).
4. **Ops tasks & reminders** (linked to bookings / route-date groups).
5. **Founder finance screen + full RBAC** (Supabase Auth, per-user, revenue/profit/exports).
6. Phase-two: agent-created bookings, payment links, WhatsApp Business API, driver DB, etc.
