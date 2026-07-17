# Quote assignment + audit trail (ops workflow notifications)

**Status: BUILT 2026-07-16 on branch `ops/quote-assignment` — NOT merged.** A1–A3 all landed
(§10). Merging deploys, and migrations now self-apply on boot, so the merge *is* the prod
schema change — held for an explicit owner go. See §11 for what must happen at release.
Owner decisions confirmed in §2.

---

## 1. Problem

The maker-checker loop is **silent**. An ops person submits a quote for review and the founder
only finds out by spotting it in the queue; the founder approves it (or sends it back) and the
ops person only finds out by looking. Everybody polls the dashboard. The worst case is a quote
sent back with "add the airport leg" that nobody sees — it just sits there, dead.

Quotes also carry **no ownership or audit**: there is no record of who created a quote, who last
changed it, or who currently holds it. (`customer_name` is the *customer* — not the staff member.)

## 2. Confirmed owner decisions (2026-07-16)

1. **Notifications follow an explicit ASSIGNMENT, not state transitions.** State-driven email
   forces the system to *guess* the recipient ("all founders", "whoever submitted"). Assignment
   states it explicitly: it scales to any team size, survives leave/reassignment, gives real
   ownership, and removes the need to infer a target at all.
2. **Manual only.** Assignment is a separate, explicit action. Submitting / approving /
   sending-back do **not** auto-assign. *Accepted trade-off:* submitting for review becomes two
   actions, and a forgotten assign means nobody is notified. (Smart defaults were offered and
   declined; revisit if quotes start going unnoticed.)
3. **Track `created_by` and `updated_by`** alongside `assigned_to`.

## 3. Scope

**In scope:** `assigned_to` (+ `assigned_at`), `created_by`, `updated_by` on quotes · an
"Assign to" action + picker · one internal email to the assignee · an "Assigned to me" queue
section · an endpoint listing assignable ops users.

**Out of scope:** auto-assignment on state change (explicitly rejected, §2) · assignment for
bookings (quotes only) · in-app/push notifications (email only) · full reassignment history
(we keep only the current assignee + `updated_by`; an append-only trail is a later idea).

## 4. Data model

Add to `quotes` — all **nullable**, since existing rows cannot be backfilled (we don't know who
made them):

| Column | Type | Meaning |
|---|---|---|
| `assigned_to` | text | ops user email currently holding it; `null` = unassigned |
| `assigned_at` | timestamptz | when it was assigned — surfaces "this has sat for 3 days" |
| `created_by` | text | ops user email who created it. Set once, never changes |
| `updated_by` | text | ops user email who last mutated it |

Migration is additive + nullable → safe, and now **self-applies on deploy** (migrate-on-boot,
PR #50), so it can't repeat the 0013/0014 drift incident.

## 5. Behaviour

- **`created_by`** — stamped on first save (creation). Immutable thereafter.
- **`updated_by`** — stamped on **every** mutation: save, status PATCH, assign.
- **`assigned_to`** — changed **only** by the explicit assign action. Never by a state change.
- **Validation (hard requirement):** `assigned_to` MUST be an email present in `OPS_USERS`, or
  `null`. Anything else is rejected. Without this, an operator could assign to an arbitrary
  address and the system would happily email a stranger a link to a customer quote.

## 6. Notification

Fires when `assigned_to` changes to a non-null value **and** the assignee ≠ the actor.

- **To:** the assignee. **Subject:** `Quote Q-XXXX assigned to you — Ceylon Hop ops`
- **Body:** who assigned it, customer, total, current status, and a deep link to the quote.
- **Deep link:** `/ops?quote=<id>` — lands the recipient on the **exact quote**, not the quotes
  list (owner decision 2026-07-16). *Verified:* `routeStateFromUrl` (`ops-ui.html:1089`) reads the
  `quote` param **before** the hash, so no `#quote` fragment is needed. (Base URL — see §9.)
  **Caveat:** the param only resolves for a viewer holding `quote:manage`; without it the link
  silently falls back to the tickets queue. Safe today — founder/finance/ops **all** hold
  `quote:manage` (`opsAuth.ts:11-13`) — but the §7 picker must list only users who do, or a future
  role gets a link that goes nowhere useful.
- **Best-effort:** a mail failure must never fail the assign (same discipline as the booking
  emails — log + carry on).
- **No email** on self-assign or on unassign.
- Delivers for real now that `send.ceylonhop.com` is verified (2026-07-16).

## 7. API

- `PATCH /admin/quote/:id` — additionally accept `assignedTo: string | null`, zod-validated
  against `OPS_USERS` (§5). Requires `quote:manage`. Stamps `updated_by`.
- `GET /admin/ops/users` **(new)** — returns `[{ email, role }]` from `OPS_USERS` for the picker.
  Requires a signed-in staff session (`bookings:read`); staff emails exposed to staff only.
- `POST /admin/quote/save` — stamp `created_by` on create; `updated_by` always.

## 8. UI (ops)

- **Quote header:** "Assigned to <person>" + an Assign picker (from `/admin/ops/users`, plus an
  "Unassigned" option).
- **Queue:** an **"Assigned to me"** section — this fits the existing "what's on your plate"
  sectioning (`Needs your review` / `Sent back to you` / `Awaiting review`), and is the stronger,
  scalable version of it. Show the assignee on each row.
- **Quote detail:** a small audit line — "Created by X · Last updated by Y".

## 9. Resolved questions

1. **Ops base URL** → **`OPS_BASE_URL` env var** (owner, 2026-07-16). Explicit beats deriving from
   the request origin, and staging needs its own value regardless. Unset ⇒ the email still sends,
   just without the button — silence would be worse than a linkless nudge.
2. **Assignee on queue rows** → **yes**, as a chip inside `.qstat`. Suppressed inside the
   "Assigned to me" section, where it would only ever read "you".
3. **`assigned_at` → an "unattended" flag** (assigned > N days, untouched): still deferred. The
   column exists, so it needs no further migration.

## 10. Milestones — all built

- **A1 — Data + API** (`5782e74`). Migration 0015, repo fields, `PATCH assignedTo` validated
  against OPS_USERS, `created_by`/`updated_by` stamping, `GET /admin/ops/users`. 10 tests.
  *Found while building:* `PATCH` returned **200** for an unknown assignee — zod silently dropped
  the field. Now a hard `400 unknown_assignee`, which is the §5 requirement made real.
- **A2 — Notification** (`7892a95`). `services/opsNotifications.ts` + best-effort trigger + the
  deep link + `OPS_BASE_URL`. 7 tests, incl. no-mail on self-assign/unassign/no-op/status-change,
  and assign-survives-a-throwing-provider.
- **A3 — UI** (`314da3b`). Assign picker (+"(you)"), audit line, "Assigned to me" **partition**
  (not an overlay — see §8), assignee chips, `assignedTo` on the list projection.
  Browser-verified against in-memory repos: assign → section appears and the status section drops
  to 1; reassign → section empties, row returns with a chip; `/ops?quote=<id>` opens that quote.

## 11. Release steps (owner)

1. **Set `OPS_BASE_URL`** on Render = `https://ceylon-hop-api.onrender.com`. Without it the
   assignment emails arrive with no button.
2. **Merge the branch.** Migration 0015 self-applies on the next boot (additive + nullable, no
   rewrite, existing rows get NULLs). Nothing else needs a manual migrate.
3. Emails deliver via the already-verified `send.ceylonhop.com` sender.

---

_Recorded 2026-07-16. Owner decisions in §2 — do not re-litigate without a new decision._
