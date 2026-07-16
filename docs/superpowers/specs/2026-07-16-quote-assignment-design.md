# Quote assignment + audit trail (ops workflow notifications)

**Status: SPEC — recorded 2026-07-16. Not built.** Owner decisions confirmed in §2.

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
- **Deep link:** `/ops?quote=<id>` — the ops router already reads the `quote` search param, so
  this lands the person on the exact quote in one click. (Base URL — see §9.)
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

## 9. Open questions

1. **Ops base URL for the deep link.** `APP_BASE_URL` points at the *customer* site, but the ops
   tool is served from the API host. Add an `OPS_BASE_URL` config, or derive it from the request
   origin? (Config is more predictable; derivation is one less env var.)
2. Show the assignee on queue rows, or only in the quote detail?
3. Later: should `assigned_at` drive an "unattended" flag (assigned > N days, untouched)? Not
   now — but the column makes it possible without another migration.

## 10. Milestones

- **A1 — Data + API.** Migration, repo fields, `PATCH assignedTo` (validated against OPS_USERS),
  `created_by`/`updated_by` stamping, `GET /admin/ops/users`. Tests: valid assign, reject
  non-OPS_USERS email, unassign, created_by immutable, updated_by moves.
- **A2 — Notification.** Assignment email template + best-effort trigger + deep link. Tests: email
  on assign-to-other, **no** email on self-assign/unassign, assign still succeeds when mail throws.
- **A3 — UI.** Assign picker, assignee display, "Assigned to me" queue section, audit line.

---

_Recorded 2026-07-16. Owner decisions in §2 — do not re-litigate without a new decision._
