# Notification safety rails — blast-radius caps and send provenance

**Status:** **PROPOSED — nothing built.** No code, schema, or config changes have been made.
**Written:** 2026-08-08. **Trigger:** owner question — *"what guards do we have that we don't send
wrong notifications? Imagine some status update via migration and we mistakenly send out a bunch of
emails or put customers in a wrong state."*
**Scope:** the customer- and staff-facing email paths in `api/` — the notifications cron, the
watchdog, the PayHere webhook, ops stage actions, and the Ride Board cutoff sweep. Pricing, the
quote engine, and the payment flow are untouched.
**Evidence base:** every claim below was read from `origin/main` at **e9f7ba2** on 2026-08-08.

Nothing in this spec changes what any email *says*, who it is addressed to under normal operation,
or when a correctly-triggered notification fires. It adds a ceiling, a kill switch, and a record.

---

## 1. The evidence

### 1.1 Every path that can send mail

| # | Path | Trigger | Dedupe ledger? |
|---|---|---|---|
| 1 | `sendBookingConfirmation` | PayHere webhook, `webhooks.ts:235` | ✅ `confirmation` |
| 2 | `sendDetailsNeeded` | PayHere webhook, `webhooks.ts:246` | ❌ none |
| 3 | `sendPaymentFailed` | PayHere webhook, `webhooks.ts:175` | ✅ `payment_failed` |
| 4 | `sendDepositReceived` | PayHere webhook, `webhooks.ts:226` | ✅ `deposit_received` |
| 5 | `sendCancellationConfirmation` | ops action, `admin.ts` `transitionAndNotify` | ❌ none |
| 6 | `sendRefundConfirmation` | ops action, `admin.ts:228` | ❌ none |
| 7 | `sendNoShowNotice` | ops stage, `ops.ts:98` | ✅ `no_show_notice` |
| 8 | `sendTripReminder` | cron, `scheduler.ts:63` | ✅ `trip_reminder` |
| 9 | `sendReviewRequest` | cron, `scheduler.ts:79` | ✅ `review_request` |
| 10 | `sendPaymentIncomplete` | watchdog, `watchdog.ts:89` | ✅ `payment_recovery` |
| 11 | `sendRideCancelled` ×2 sites | cron, `rideBoardCutoff.ts:54,111` | ❌ none |
| 12 | `sendRideConfirmed` | cron, `rideBoardCutoff.ts:96` | ❌ none |
| 13 | `sendRideAtRisk` | cron, `rideBoardCutoff.ts:97` | ❌ none |
| 14 | `sendQuoteAssigned` / `AwaitingApproval` / `SentBack` | ops action, `internalQuote.ts:1391–1410` | ❌ none |

**Six of the fourteen leave no durable record that a send happened.** Three of those (11–13) sit in
the Ride Board cutoff sweep, which also **charges cards** in the same loop.

**The structural guard that already works:** there are no database triggers, no outbox worker, and
no `LISTEN/NOTIFY`. Every send is an explicit call in application code. A migration therefore
cannot send an email *directly*. It can only change the state that a later cron tick reads —
which is the whole of the exposure this spec addresses.

### 1.2 What the dedupe ledger does, and does not, protect

`notification_log(booking_id, kind, sent_at)` with `UNIQUE(booking_id, kind)`
(`drizzle/0008_notification_log.sql`). It stops the **same kind** going to the **same booking**
twice — including across restarts and redeploys. That is real and worth keeping.

It does **not** stop a *first* send. If a booking becomes newly eligible for a kind it has never
received, the ledger is empty for that pair and the mail goes out. Every failure mode in §2 is a
first send.

The read/write pair is also not atomic. `PostgresNotificationLogRepo` (`postgresNotificationLogRepo.ts`)
carries the comment *"markSent relies on the (booking_id, kind) unique constraint for atomic
idempotency under concurrent ticks."* The call sequence is `wasSent` → send → `markSent`. Two
concurrent runs both read `false`, both send, and the second `markSent` is absorbed by
`onConflictDoNothing`. The constraint guarantees one **row**, not one **email**. The comment
overstates what the code does.

### 1.3 The tick is unbounded

`runScheduledNotifications` (`scheduler.ts:51`) opens with `await bookings.list()` — every booking
ever created, no date bound, no limit — then emails each eligible one in a `for` loop. There is no
cap, no batching, no abort, and no alert on volume. The same is true of `runRideBoardCutoff`.

`POST /admin/jobs/notifications` (`admin.ts:485`) runs the scheduler, the stale-hold sweep, the
Ride Board cutoff, quote expiry, and the abandoned-draft sweep on one tick, and returns counts.

### 1.4 What you can reconstruct after the fact

**Recorded:** the eight logged kinds give you `booking_id`, `kind`, `sent_at`. So: *did this
customer get the reminder, and when.*

**Not recorded, anywhere:**

- **Why** it fired — the eligibility inputs (status, trip dates, age) at decision time.
- **Which run** — no run id, so a burst cannot be attributed to a single tick.
- **What triggered it** — webhook vs cron vs watchdog vs a human ops action.
- **Who** — no actor on any send.
- **Which address** it actually went to.
- Anything at all for the six unlogged paths in §1.1.

**No audit trail on the state changes that cause sends.** `bookings` carries
`cancellationReason` / `cancelledBy` / `cancelledAt` — cancellation only. `refunds` stores a reason.
Every other transition (`paid → confirmed`, `confirmed → no_show`, `→ completed`) changes with no
record of who, when, or why. "Was this booking moved by a human or by a migration?" is currently
unanswerable.

**The pattern already exists in this codebase.** `payment_events` (`schema.ts:200`) stores the
provider payload SHA, a sanitised payload, and `received_at`, unique per
`(provider, txn, status)` — genuine forensics. `quote_revisions` (`schema.ts:525`) carries
`updated_by`. Notifications simply never got the same treatment.

**Structured logging exists but is near-unused.** `observability/events.ts` was built for exactly
this — its header says *"why did this van get called off" is a grep, not an archaeology dig* — and
has six call sites, all Ride Board. **No email send emits one.** Output goes to Render stdout:
rotating, ephemeral, not queryable weeks later. Sentry (`observability/track.ts`) captures
failures only, never sends.

### 1.5 Environment separation is convention, not code

The only thing deciding whether real mail leaves the process is the presence of `RESEND_API_KEY`
(`server.ts:60`). `docs/staging-environment-plan.md:45` states staging must leave it unset. Nothing
in the code knows which environment it is running in, and nothing would stop a staging instance
with a prod-restored database from emailing real customers. *(That staging's key is in fact unset
today was not verified in this session — it requires Render dashboard access.)*

---

## 2. Failure modes

**F1 — Migration wakes the dormant backlog.** A migration backfills `bookings.dates`, or sets a
batch of old rows to `completed`/`paid`. On the next tick, every one of them passes the
`review_request` or `trip_reminder` predicate for the first time. The ledger is empty for those
pairs, so nothing stops it. Hundreds of "how was your trip?" emails to customers who travelled
months ago, or never travelled at all. **This is the scenario as asked, and nothing currently
prevents it.**

**F2 — A new notification kind is retroactive by default.** Adding a value to `NotificationKind`
means zero rows exist for it. Every historical booking that satisfies the predicate is a first
send. This is the most likely way F1 actually happens — through a feature, not a mistake.

**F3 — Ledger loss.** A truncate, a bad restore, or a migration that rebuilds the table erases the
only thing preventing a full re-send of all eight logged kinds.

**F4 — Concurrent ticks double-send.** A manual `POST /admin/jobs/notifications` overlapping the
external cron. Bounded (2×) and low-harm, but real, and the code comment claims otherwise.

**F5 — Ride Board re-blast, with charges.** `rideBoardCutoff.ts` is idempotent only because a
confirmed/expired list stops matching `dueForCutoff`. A migration touching `ride_lists.status` or
`cutoff` re-emails **and re-charges held cards**. Highest severity in this document: it moves money,
and it has no ledger at all.

**F6 — Staging emails production customers.** Per §1.5. One environment-variable mistake, or one
prod→staging data refresh, is the entire distance between safe and not.

---

## 3. Design decisions

- **D1 — Cap before correctness.** A cap is the only rail that helps against a failure nobody
  predicted. It ships first, before any of the fixes for specific modes.
- **D2 — Fail closed on a burst, and page.** When a run exceeds its cap it sends **nothing further**
  and raises a `critical` alert. A delayed reminder is recoverable; four hundred wrong emails are
  not. Cheap to recover from a false positive: raise the cap and re-run.
- **D3 — One choke point.** `hasDeliverableAddress()` in `adapters/email.ts` (added 2026-08-08 for
  customers without an email) already proves that all ten senders funnel through the adapter. The
  allowlist and kill switch belong there, not in fourteen call sites.
- **D4 — Provenance is written at the moment of decision, not derived later.** `decision_json`
  captures the eligibility inputs as they were when the send fired. If a migration later overwrites
  those columns, the evidence survives — this is the same reasoning that makes `payment_events`
  useful.
- **D5 — Extend `notification_log`; do not add a parallel table.** The dedupe key stays exactly as
  it is. New columns are additive and nullable, so pre-existing rows keep working untouched.
- **D6 — Ledger every send, dedupe only some.** Kinds that must fire once keep the unique
  constraint. Kinds that may legitimately repeat (cancellation, refund, staff emails) are recorded
  without it. Recording and deduping are separate concerns and currently conflated.
- **D7 — No new infrastructure.** No queue, no outbox worker, no scheduler service. Everything
  here is columns, a counter, an env var, and an alert on rails that already exist.

---

## 4. The rails

### R1 — Per-run burst cap *(the load-bearing rail)*

`NOTIFY_MAX_PER_RUN`, default **25**, in `config.ts`.

`runScheduledNotifications`, `runWatchdog`, and `runRideBoardCutoff` each count sends within a run.
On reaching the cap the run **stops sending immediately** — it does not finish the loop — and
raises:

```
severity: critical
kind:     notification_burst_suppressed
title:    Notification burst suppressed — 25 sent, 412 still eligible
body:     run_id, the kind breakdown, and the first 5 booking references
```

Already-sent mail in that run is ledgered normally. Nothing is retried automatically; clearing it is
a human decision. For Ride Board the cap covers **charges as well as emails** — the charge loop
stops with the mail loop (F5).

25 is comfortably above any legitimate tick at current volume and far below a blast. It is one env
var to raise on a real busy day.

### R2 — Claim-then-send

Replace `wasSent` → send → `markSent` with:

1. `INSERT … ON CONFLICT DO NOTHING RETURNING *` — if no row returned, someone else owns this send; skip.
2. Send.
3. On send failure, delete the claim so a later run can retry.

Closes F4 and makes the existing comment in `postgresNotificationLogRepo.ts` true. `NotificationLogRepo`
gains a `claim(bookingId, kind): Promise<boolean>`; `wasSent`/`markSent` stay for the read paths that
need them (the watchdog's `paid_unconfirmed` check).

### R3 — Kill switch and recipient allowlist

Two optional env vars, enforced inside `EmailAdapter.send` beside `hasDeliverableAddress`:

- `NOTIFICATIONS_ENABLED` — when `false`, every send is dropped and counted. The lever you pull
  while something is actively going wrong.
- `EMAIL_ALLOWLIST` — comma-separated addresses or `@domain` suffixes. When set, non-matching
  recipients are **dropped and logged, not sent**. Unset means no filtering, so production is
  unaffected.

Staging sets `EMAIL_ALLOWLIST=@ceylonhop.com`. Environment separation stops depending on remembering
to leave a key unset (F6). Every drop emits a `notification.suppressed` event with the reason.

### R4 — Send ledger: the "why" and "when"

Additive nullable columns on `notification_log`:

| Column | Type | Purpose |
|---|---|---|
| `source` | text | `webhook` \| `cron:notifications` \| `watchdog` \| `ops_action` \| `ride_board` |
| `run_id` | uuid | one per tick — makes a burst a single query |
| `actor` | text | staff email, or `system` |
| `to_address` | text | what was actually sent to |
| `decision_json` | jsonb | eligibility snapshot: status, trip start/end, age at decision (D4) |
| `suppressed_reason` | text | set when a send was *decided* but not delivered (cap, allowlist, kill switch) |

Then extend coverage to the six unlogged paths in §1.1, with `NotificationKind` gaining
`cancellation`, `refund`, `details_needed`, `ride_confirmed`, `ride_cancelled`, `ride_at_risk`, and
the three ops-staff kinds — recorded, not deduped, per D6.

And emit `logEvent('notification.sent', …)` on every send, so a burst is greppable in Render
*while* it is happening, not only in Postgres afterwards.

### R5 — `booking_status_events`

```
id, booking_id, from_status, to_status, actor, source, reason, at
```

Generalises the `cancellationReason`/`cancelledBy`/`cancelledAt` trio that already exists for
cancellations. Written by `bookings.setStatus`, so no call site has to remember. This is what
answers *"human or migration?"* — and it pairs directly with R1: the cap tells you something is
wrong, this tells you what caused it.

### R6 — Relevance window

`NOTIFY_MAX_TRIP_AGE_DAYS`, default **30**. Never send a trip reminder or review request about a
trip that ended more than this long ago, regardless of ledger state. Kills F1 and F3 outright — a
backfill cannot wake bookings from months ago, because they fail the window before the ledger is
even consulted.

Optionally paired with `NOTIFY_EPOCH` (an ISO date): never notify about a booking created before it.
One line, and it permanently fences off the pre-launch backlog.

### R7 — Dry run

`POST /admin/jobs/notifications?dryRun=1` performs the full eligibility pass, writes nothing, sends
nothing, and returns the list of booking references with the kind and reason each would receive.
The instrument you reach for after any migration that touched booking state — look before firing.

### R8 — Process rules (`CLAUDE.md`)

1. A new `NotificationKind` **ships with a backfill migration** seeding log rows for all
   pre-existing bookings, so it starts at "already sent" (F2).
2. A migration touching `bookings.status`, booking dates, `notification_log`, or `ride_lists`
   **must state its notification impact in the PR description**, and the author must run R7 against
   staging after it applies.

---

## 5. Schema changes

Three migrations, each independently revertible:

1. `notification_log` — six additive nullable columns (R4). No constraint changes; existing rows and
   the unique key are untouched.
2. `notification_log` — widen the `kind` vocabulary (R4 coverage). Data-only.
3. `booking_status_events` — new table (R5).

**Merging a migration IS its release**: pending migrations auto-apply on Render boot, fail-closed,
so each hits **staging** the moment it merges to `main` and **prod** only on the `main → production`
promote. All three are additive; none rewrites or drops existing data.

---

## 6. Build order

Each slice is a branch, a PR, and green CI on its own.

| Slice | Contents | Schema? | Why this order |
|---|---|---|---|
| **1** | R1 burst cap + alert | no | Stops the bleeding for every failure mode, including unanticipated ones. Highest value per line changed. |
| **2** | R3 kill switch + allowlist | no | Env-only; makes staging structurally safe (F6) and gives an in-flight lever. |
| **3** | R2 claim-then-send | no | Small, closes F4, corrects a false comment. |
| **4** | R4 send ledger | yes (1, 2) | The "why/when" the owner asked for. Needs 1–3 in place to be worth querying. |
| **5** | R6 relevance window + R7 dry run | no | Cheap; retires F1/F3 as a class. |
| **6** | R5 `booking_status_events` | yes (3) | Largest surface; the "human or migration" answer. |

Slices 1–3 are roughly a day with tests and carry no schema risk. **R8 (the two `CLAUDE.md` rules)
costs nothing and should land with slice 1.**

---

## 7. Testing

Per the maintenance-mode rule, each behavioural change lands red→green.

- **R1** — a fixture of 100 eligible bookings; assert exactly 25 sends, one `critical` alert with the
  correct pending count, and that the Ride Board charge loop stopped with the mail loop.
- **R2** — two concurrent `runScheduledNotifications` over the same booking; assert exactly one send.
  Assert a failed send leaves no claim behind.
- **R3** — `EMAIL_ALLOWLIST` set: assert non-matching recipients are dropped, a
  `notification.suppressed` event is emitted, and matching ones still send. `NOTIFICATIONS_ENABLED=false`:
  assert zero sends across every path.
- **R4** — assert `run_id` is stable within a run and distinct across runs; assert `decision_json`
  captures status and trip dates as they were at decision time.
- **R6** — a booking whose trip ended 60 days ago with an empty ledger: assert no send. **This is the
  direct regression test for the owner's scenario** and should be named as such.
- **R7** — assert dry run writes nothing to `notification_log` and sends nothing.

---

## 8. Non-goals

- No queue, outbox, or retry infrastructure (D7).
- No change to email content, design, or the "concierge letter" direction.
- No change to who is notified under correct operation.
- No unsubscribe or preference centre — worth its own spec before real volume; out of scope here.
- No WhatsApp path. This spec is email only.

---

## 9. Open owner calls

1. **Cap value.** 25/run proposed. Should the Ride Board cutoff carry a separate, lower cap, given
   it charges cards?
2. **Relevance window.** 30 days proposed. And is `NOTIFY_EPOCH` worth setting to the go-live date
   to fence off the entire pre-launch backlog permanently?
3. **Burst recovery.** When a suppressed burst turns out to be legitimate, is clearing it always a
   human raising the cap and re-running, or is an "approve and resume" ops action wanted later?
4. **Slice 6 timing.** `booking_status_events` is the largest change here. Before or after the apex
   cutover?
