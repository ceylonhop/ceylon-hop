# Ceylon Hop — Ops Dashboard: status & resume notes

**Last updated: 2026-07-03.** This is the canonical "where we are" record for the **ops
dashboard (M12)**. Read this top-to-bottom before resuming.

> **2026-07-03 — Slice 2 (reshape + wire-up) SHIPPED** on branch `m12s2-ops-dashboard`.
> The backend now matches the agreed post-payment model in §1: `bookings.channel`
> (website|whatsapp) added; ride fulfilment lifecycle simplified to
> `paid → vehicle_confirmed → pickup_confirmed → on_trip → completed`; the whole coordinator
> layer removed (repos, `/coordinators`, `/manifest`, `/rides`, `/bookings/:id/assign`; the
> `coordinators` table + `ride_ops.coordinator_id` dropped via migrations 0011–0013). The
> "Control Tower" UI is served at **`GET /ops`**, wired to `/admin/ops` with a session-cookie
> **login screen** — no more static mock. Verified end-to-end against dev Supabase (login,
> live queue, stage advance, flag/note persistence). Plan: `docs/superpowers/plans/2026-07-03-m12-ops-dashboard-slice-2.md`.
> **Still TODO before real traffic:** the deploy runbook below + the WhatsApp
> PayHere-payment-link generator (§4). The quote generator itself now ships inside `/ops`.

---

## 1. What the ops dashboard IS (the agreed model)

**Ops is a post-payment fulfilment cockpit — not a quoting/conversation tool.**

- A booking only appears in ops once it is **paid** (or, on the WhatsApp/manual channel,
  **`payment_pending`** — shown as a follow-up trigger after a payment link was sent).
- **All pre-payment work lives OUTSIDE ops** (lead → quote → payment-link → chase) in
  **WhatsApp + Notion/CMS**. We are explicitly *not* building a Zendesk/conversation tracker.
- **Two origins, one lifecycle:**
  - **Website** booking → customer pays at checkout → lands in DB as paid → appears in ops.
  - **WhatsApp/manual** booking → agent agrees the price in WhatsApp and generates a **PayHere
    payment link** (via a tool that lives *outside* ops). That link writes the booking into the
    **same DB**. So **ops has no "create booking" form** — manual bookings arrive via the same
    payment rail.
- **Channel** (`website` | `whatsapp`) is just a **tag** for context.

### Fulfilment lifecycle (the only statuses ops cares about)
```
awaiting_payment → paid → vehicle_confirmed → pickup_confirmed → on_trip → completed   (+ cancelled)
```
- `awaiting_payment` = manual channel only, a chase trigger ("link sent, follow up").
- "Vehicle assigned for the car" is tracked by the **`vehicle_confirmed`** stage (the
  "Confirm vehicle" action), backed by a **"Vehicle photo received"** toggle as proof.

### Decisions made along the way (don't re-litigate)
- **No owner/assignee / no "Mine" filter** — small team works one shared queue. Removed.
- **Coordinators removed from the UI for now** — vehicle assignment is the `vehicle_confirmed`
  stage, not a coordinator hand-off. (Coordinator data still exists in the *backend* — see §3.)
- **Message-templates page removed**; the per-booking **"Message"** action + a **"Payment
  reminder"** template are kept (that's the awaiting-payment chase).
- **payment_pending visibility:** show all (website abandons assumed rare). Revisit if noisy →
  could restrict to manual-channel only.
- **One nav destination: "Bookings."** "Today's rides" was merged in as a **time-series
  grouping**, not a separate page.

---

## 2. The PROTOTYPE (front-end mockup) — DONE & in a good state

**File:** `_ops-preview.html` at the **ceylon-hop repo root** (single-file HTML/CSS/JS, mock
in-memory data). **Still tracked in git at the repo root** — the retire step (resume checklist #5)
never happened; it should be `git rm`'d now that the live `/ops` UI supersedes it. Served via the preview server
at `http://localhost:4173/_ops-preview.html` (server root = the `ceylon-hop` folder).

### What it does
- **Single "Bookings" queue**, grouped **time-series**: **Pending → Today → Tomorrow →
  Upcoming → Completed**, sorted by departure time within each group. Empty groups are hidden.
  - *Pending* = `awaiting_payment` / undated (amber header). *Today* = teal header w/ date.
- **Status facet filters** across the top with live counts + color dots:
  `All open · Awaiting payment · Needs vehicle · Ready · On trip · Completed`. Facets filter;
  the time-grouping organizes.
- **Booking detail slide-over**: Pipeline stepper (+ single next-stage action) · Customer
  (+ Message) · Trip (+ multi-leg quote table) · **Payment** (read-only: amount/status/channel;
  awaiting → "follow up with Payment reminder" note, *no* send-link/quote buttons) ·
  **Vehicle & pickup** (Vehicle, Assigned y/n, "Vehicle photo received" + "Customer contacted ·
  pickup confirmed" toggles) · Activity log (+ add note).

### Design system — "Control Tower" (award-winning pass)
- **Dark espresso left rail** with teal aurora glow; warm cream content field with faint
  paper-grain + radial gradients.
- **Fonts:** Newsreader (display serif, for names/amounts), Hanken Grotesk (body),
  JetBrains Mono (refs/times). Loaded via Google Fonts.
- **Per-stage semantic colour** carried through a **left colour-spine on each row**, the pill,
  and the pipeline nodes:
  `awaiting=amber #c7841f · paid=green #2f9558 · vehicle=violet #6d4fb8 ·
   pickup=teal #0a8f86 · on_trip=blue #1f6fd0 · completed=grey #7c7a73`.
- **Two-axis colour rule (important):** the **stage colour = where it is** (Paid is GREEN — a
  win); **RED is reserved for the action still needed** (the "Vehicle not confirmed yet" tag).
  Never colour a positive state red.
- **Connected pipeline stepper** where each completed node glows in its own stage colour and the
  current node pulses. Hairline-separated detail sections (not box-soup).
- **Motion:** staggered row reveal, hover lift + spine-widen, light-sweep sheen on the primary
  button. `prefers-reduced-motion` respected. Uses CSS `color-mix()` (modern browsers only).

### State of the prototype code
- Verified: renders clean, console error-free, responsive down to ~740px, facets regroup,
  detail opens, pipeline actions advance stages.
- **Known dead code to prune later** (harmless, unreachable): `viewSchedule`,
  `viewCoordinators`, `viewTemplates`, `setCoordModal`, `manifestModal`, and the
  `setcoord/pickcoord/manifest/newcoord/tpl/copytpl/watpl/copymanifest` handler cases. The
  `coordinators`/`cname`/`team`/`ME`/`owner` data + `.owner` CSS are also now unused.

---

## 3. The BACKEND (already built & DEPLOYED) — and how it now DIVERGES

**M12 Slice 1 shipped to `main` + deployed to Render**, migration `0007_ops_layer.sql` applied
to live Supabase, **152 tests green in CI**. It lives in `api/` only (per CLAUDE.md rules).

What's there:
- Tables **`coordinators`** + **`ride_ops`** (`api/src/db/schema.ts`, repos +
  `postgres*Repo.ts`).
- `api/src/domain/rideStatus.ts`: status machine
  `unassigned → assigned → sent_to_coordinator → acknowledged → vehicle_confirmed →
   customer_updated → completed`.
- **Role-session auth** (`api/src/lib/opsAuth.ts`): support/founder via HMAC cookie.
- Routes mounted at **`/admin/ops/*`** (`api/src/routes/ops.ts`): login/logout/whoami,
  bookings list+detail (filter/search), assign/status/flags, rides, coordinators, manifest,
  founder-gated finance summary. View-model in `api/src/services/opsView.ts`.

### ⚠️ The backend is coordinator-centric (Slice 1) and no longer matches the agreed UI model.
**Backend reshape TODO (do this when we resume, before wiring the UI):**
1. **Add `channel`** (`website` | `whatsapp`) to bookings — default `website` at checkout, set
   `whatsapp` for agent-payment-link bookings.
2. **Simplify ride fulfilment status** to match the UI:
   `paid → vehicle_confirmed → pickup_confirmed → on_trip → completed`.
   - Rename `customer_updated → pickup_confirmed`.
   - Drop the coordinator-handoff statuses (`assigned`, `sent_to_coordinator`, `acknowledged`).
   - Decide: drop the `coordinators` table/endpoints, or leave dormant (UI no longer uses them).
3. **Ops list query** → bookings where `status IN (paid, payment_pending)`, return `channel`,
   ordered by travel date.
4. Update `opsView` + route tests (TDD red→green), new migration, deploy. Keep CI green.
5. **Wire the prototype UI to the live `/admin/ops` API** and **serve it at `/ops`** (today the
   UI is a static mock with in-memory data + a fake login identity in the rail).

---

## 4. Deferred / open items (not blocking the main-site work)
- **The WhatsApp PayHere-payment-link generator** (custom price → payment link) is the only
  remaining unbuilt piece. The quote generator itself now **ships inside `/ops`** (the Ops Quote
  Generator, `/admin/quote`, founder/`quote:manage`-gated, PR #14, deployed 2026-07-04). Manual
  bookings still need the payment-link step before they can flow into the DB.
- **Render env vars for ops auth** (also in `docs/go-live-checklist.md`):
  `OPS_SESSION_SECRET` (strong), `OPS_USERS` (email:role list) and `GOOGLE_OAUTH_CLIENT_ID`
  (auth is Google sign-in + roles since the 2026-07-04 RBAC change — `OPS_FOUNDER_KEY` /
  `OPS_SUPPORT_KEY` are no longer read by the API), plus `ADMIN_API_KEY` (machine/cron identity).
- Login screen for `/ops`; trim the prototype's dead code (§2).
- Customer-email roadmap (cancellation/refund/deposit/reminders) — separate track, see the
  email roadmap notes + `docs/go-live-checklist.md`.

## 5. Related docs
- `docs/ops-dashboard-slice-1-spec.md` — original Slice 1 spec (coordinator model; partly
  superseded by §1 here).
- `docs/ops-dashboard-slice-1-backend-plan.md` — the backend build plan that shipped.
- `docs/go-live-checklist.md` — production switch-over (incl. ops env vars).

---

### Resume checklist (TL;DR)
1. ~~Reshape the backend~~ ✅ DONE (Slice 2, 2026-07-03).
2. ~~Wire UI → `/admin/ops`, login screen, serve at `/ops`~~ ✅ DONE (Slice 2).
3. **Deploy** — apply migrations 0011→0012→0013 to live Supabase *before* the new image serves
   traffic; set Render env vars (`OPS_SESSION_SECRET`, `OPS_USERS`, `GOOGLE_OAUTH_CLIENT_ID`,
   `ADMIN_API_KEY`). See the deploy runbook in the Slice 2 plan / PR.
   ⚠️ 0013 drops the `coordinators` table irreversibly — snapshot the prod DB first.
4. Build/locate the external WhatsApp quote→PayHere-link tool (§4) — still the only path for
   manual bookings to enter the DB; ops has no create-booking form by design.
5. Retire the root `_ops-preview.html` mock (superseded by the live `/ops` UI).

**Prod hardening — DONE:** the ops session cookie now sets `Secure` (httpOnly + SameSite=Lax +
path=/ + Secure, `api/src/lib/opsMiddleware.ts`), shipped with the permissions/roles slice.
