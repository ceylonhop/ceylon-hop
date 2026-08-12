# Ops self-approval for simple transfers — build plan (phase 1)

**Owner decision:** 2026-08-11. No separate design spec — the decisions are recorded in full below.

**Goal:** An `ops` agent can take a single-leg, standard-priced private transfer all the way to a
paid booking on their own — build it, price it, approve it, send it, mint the pay link, convert it
— without a founder in the loop. Approval is what unlocks the last three (see decision 5), so this
is a money permission, not a status one. Every other quote shape, and every other founder-only
action, is unchanged.

**Architecture:** A new capability `quote:approve_simple`, held by `ops` only, that is **never
sufficient on its own**. It admits a status move to `ready` only when a pure predicate says the
stored quote qualifies. `quote:approve` keeps meaning "founder" and keeps gating hot zones,
locked-quote deletion, send-back and reopening a sent quote — so none of those are touched by
construction. The predicate is a standalone, fully-unit-tested function over the stored engine
request; the route and the UI both consume it, the UI via a per-quote flag on the payload.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · npm. No new dependency.

## Global Constraints

- **One task = one branch = one PR.** Build only what the task's Files list says.
- **Tests first, proven.** Failing test, run it red, implement to green, paste red→green in the PR.
- `cd api && npm run check` green before every PR; `npm run test:all` too for Task 4.
- **Never `git add -A`.** Multiple sessions share this working tree; stage by path.
- **No migration, no schema change, no `config.ts`, no rate-card touch.** If a task appears to need
  one, stop and ask — it means the design is wrong, not that the rule needs relaxing.
- Line references below are as of 2026-08-11 and drift; re-grep at execution time.

## The qualifying rule (normative)

A quote qualifies for ops self-approval when **all five** hold:

1. `product === 'private'`
2. exactly **one** leg in the stored **engine** request
3. vehicle is not `custom`
4. no custom per-km rate is set
5. no active discount on the quote

Anything else — chauffeur, two or more legs, the custom tier, a hand-set $/km, a founder discount —
stays founder-only, unchanged.

## Scope decisions taken before writing this plan

Recorded so a reviewer does not re-litigate them:

1. **One leg only, for now.** Expanding to two is a separate, later step and **must** ship with a
   companion "all legs same date" rule — see *Deferred* below for why that pairing is not optional.
2. **Van 14 is in.** It prices off the standard card (`rateCard.ts`: 48¢/km, $85 floor). It is also
   the only standard tier that *may* carry a hand-set $/km, and rule 4 catches that case directly.
   Excluding the vehicle as a proxy for excluding the override would be the wrong lever.
3. **No dollar ceiling.** With one leg and no custom pricing, the total is already bounded by the
   longest corridor at the highest standard rate. A ceiling would be a second number to maintain
   for no additional protection. It becomes worth revisiting at two legs.
4. **No notification** — and this takes work, it is not the default. `quote_revisions` already
   retains one row per superseded state carrying `status` and `updatedBy` (`schema.ts:620`), and
   the live row keeps `updatedBy` — so "what did ops approve, and who" is a query, not a feature.

   **The catch (found 2026-08-11, after the first draft):** `draft → ready` does not exist. It was
   removed 2026-07-19 (`quoteRepo.ts:14-21`) and `ready` is reachable **only** from
   `pending_review`. So ops cannot self-approve in one hop — they submit, then approve. And
   submitting emails every `quote:approve` holder except the actor (`internalQuote.ts:1611`),
   i.e. the founder. Left alone, this decision inverts itself: the founder gets an "approve this"
   mail for **every** simple transfer, resolved by ops seconds later — a request for action that
   was already actioned. Task 2 therefore suppresses that mail when the submitter could
   self-approve the quote. Not optional; without it Task 2 ships a violation of this decision.

   Silver lining: the forced `pending_review` hop means content freezes *before* approval, so ops
   approves exactly what ops submitted, and the submitted state gets its own revision row.
5. **Ops owns the whole chain for this class — including taking the money.** State this plainly,
   because "approve" undersells it. Approval is the unlock for two further gates ops *already*
   holds the capability for:
   - **the pay-link mint** (`internalQuote.ts:1145`) carries no explicit `requireCap` — it
     inherits the router's `quote:manage` (`:706`), which ops has, and its real gate is
     `status ∈ {ready, sent}`;
   - **booking conversion** (`:1008`) needs `bookings:operate`, which ops has, at `sent | won`.

   So the reach is `draft → pending_review → ready → sent → pay link → customer pays → booking`,
   entirely within ops. Not merely a status change: **ops can collect payment against a price no
   second person saw.** That is the intended purchase for a single standard-priced transfer with no discount and
   no custom rate — owner confirmed 2026-08-11 with the payment reach explicitly on the table —
   but it is the sentence to re-read before widening the rule. Maker-checker is deliberately
   collapsed for this class. Ops still cannot discount (`discount:apply_manual` is founder-only)
   and still cannot see margin.
6. **No kill switch.** Rollback is a revert PR through staging → promote. Accepted at this blast
   radius rather than adding a `config.ts` flag, which is itself a stop-and-ask surface.

## The trap this plan exists to avoid

The stored request is a **wrapper**: `request: { tool: body, engine: req }`
(`internalQuote.ts:921`). There is no top-level `legs`. The two halves use different vocabularies
for the same concepts:

| concept | `request.tool` | `request.engine` |
|---|---|---|
| legs | authored itinerary, **includes stay-day legs** | driving legs only, private branch (`:404`) |
| vehicle | `car`, `van_6`, `van_9`, `van_14`, `custom` | `car`, `van`, `van9`, `van14`, `custom` |
| custom rate | `customRatePerKmCents` | `customPerKmCents` |

Reading the wrong half fails **asymmetrically**, and that is the whole risk:

- A wrong **leg count** read yields `undefined === 1` → false → nothing qualifies → ops approves
  nothing. Annoying, visible, safe.
- A wrong **custom-rate** read yields `undefined == null` → true → "no custom rate" → the quote
  **passes**. Silent, no error, no failing test unless that exact case is written. This fails open
  on precisely the hand-priced quote the rule exists to exclude.

Therefore: the predicate reads `request.engine` **only**, never `tool`, never a mix — and Task 1's
fixtures are captured from a real `/save` round-trip, never hand-authored. A hand-authored fixture
encodes the mistake into the test and goes green.

## File Structure

**New files**
- `api/src/quote/simpleApproval.ts` — the predicate. Test: `api/src/quote/simpleApproval.test.ts`.

**Modified files**
- `api/src/lib/opsAuth.ts` — add `quote:approve_simple` to `OpsAction` and to the `ops` row (+ test).
- `api/src/routes/internalQuote.ts` — the approve-gate fall-through; `mayApprove` on the detail and
  list payloads (+ tests).
- `api/src/routes/ops-ui.html` — per-quote approve gating (+ Playwright). **Two `isApprover()`
  definitions live here (`2416`, `4078`); the builder's is `4078`. See Task 4.**
- `docs/quote-lifecycle-user-stories.md` — the declared source of truth for this lifecycle. Task 5.

---

### Task 1: The predicate

**Depends on:** nothing. Pure logic, no Hono, no I/O.

**Files:** new `api/src/quote/simpleApproval.ts` (+ test)

Produces `canOpsSelfApprove(quote: SavedQuote): boolean` implementing the five-part rule against
`request.engine` only.

**It must be total and fail closed on every shape it does not recognise:** unpriced shells
(`request: { shell: true }`, `internalQuote.ts:842`), a missing or malformed `engine`, the chauffeur
shape, and any legacy row predating the wrapper. Unknown shape → not approvable. This matters more
than it looks: Task 3 computes the flag for *every row in the queue*, not only on the approve path,
so a throw here is a broken queue, not a denied approval.

Carry a comment naming both field-name traps from the table above, so the next reader does not
re-derive the shape from the tool payload and reintroduce the fail-open.

**Tests:** a qualifying single-leg private quote → true. Each of the five clauses violated in
isolation → false, **including an explicit custom-`$`/km case** (the fail-open). Chauffeur → false.
Two legs → false. Shell → false. `engine` absent → false. Fixtures captured from a real `/save`
round-trip, asserted against the actual stored JSON, not hand-written objects.

---

### Task 2: Capability and the approve gate

**Depends on:** Task 1.

**Files:** `api/src/lib/opsAuth.ts`, `api/src/routes/internalQuote.ts` (+ tests)

Add `quote:approve_simple` to `OpsAction` and to the `ops` row of `CAPABILITIES`. **Comment it at
the definition: this cap is never sufficient on its own — gate the UI on the per-quote flag, not on
`caps.includes(...)`.** It lands in the derived `ALL_OPS_ACTIONS` and therefore in ops's `caps`
array at `/admin/ops/whoami` (`ops.ts:166`), which is exactly the shape that invites a flat check.

At the existing gate (`internalQuote.ts:1532`), allow the move when the actor holds
`quote:approve_simple` **and** `to === 'ready'` **and** `canOpsSelfApprove(current)`. Nothing else
changes: `changes_requested`, reopening a `sent` quote, hot zones (`:1401–1417`) and locked-quote
deletion (`:1653`) keep requiring `quote:approve`.

The two branches are **provably disjoint**, which is why no extra guarding is needed: `reopeningSent`
requires the target to be in `EDITABLE` (`draft` | `pending_review` | `changes_requested`), and
`ready` is not in that set — so the new path cannot admit a reopen of a sent quote.

**Also suppress the awaiting-approval email** (`:1611`) when the submitter could self-approve the
quote they are submitting — see decision 4. Same predicate, evaluated on the row being moved to
`pending_review`. Without this, every ops self-approval mails the founder a request that is
resolved seconds later. The mail must still fire for every quote ops **cannot** self-approve, which
is the case that matters.

**Tests:** ops approves a qualifying quote. Ops is refused (`approve_forbidden`) on each
disqualifying shape. Ops still cannot send a quote back, reopen a sent quote, edit a hot zone,
delete a locked quote, or apply a discount. Founder behaviour is unchanged throughout. **No
awaiting-approval mail on submitting a qualifying quote; the mail still sends on a
non-qualifying one, and still sends when finance submits** (finance has no
`quote:approve_simple`, so nothing about their flow changes). Plus one regression test that
`/save` still 409s `not_editable` on a `ready` quote (`:867`) — the gate's safety rests on content
being frozen after approval, and nothing currently records that dependency.

---

### Task 3: `mayApprove` on the payloads

**Depends on:** Task 2.

**Files:** `api/src/routes/internalQuote.ts` (+ tests)

Add a per-quote `mayApprove` boolean to the quote **detail** payload **and the queue list payload**.
Both: if the queue renders any approve affordance per row, a detail-only flag leaves the list
guessing. Value is `can(role, 'quote:approve') || (can(role, 'quote:approve_simple') && canOpsSelfApprove(q))`.

**Tests:** founder sees `true` on every quote; ops sees `true` only on qualifying quotes; both
endpoints agree on the same quote.

---

### Task 4: Ops UI

**Depends on:** Task 3. Runs `npm run test:all`.

**Files:** `api/src/routes/ops-ui.html` (+ Playwright)

**`isApprover()` is defined TWICE in this file, and the approve button uses the second one:**

| line | scope | reads |
|---|---|---|
| `2416` | ops shell / queue | `state.caps` |
| `4078` | **quote builder — the approve button lives here** | `window.opsCaps` via `viewerCan()` |

Same name, different data source. Editing `2416` alone is a faithful-looking change that does
nothing to the button. Start at `4078`.

**Do not promote ops to approver globally.** `isApprover()` has eight call sites and most of them
are not the approve button: queue section layout (`2606`), queue headline copy (`2624`), the lock
subtitle (`7944`), the action bar (`8004`), and `8233`–`8243`. `QUEUE_SECTIONS_APPROVER` vs
`QUEUE_SECTIONS_SUPPORT` means a flat flip would restructure an ops agent's entire queue into a
founder's review layout. **Only the per-quote approve affordance changes** — it reads `mayApprove`
from Task 3. Every other call site keeps its current founder-only meaning, and the Playwright
suite must prove that.

Note `copyUnlocked()` (`4080`) is status-based, not cap-based, so self-approval unlocks copying the
customer-facing message with no change here. That is intended; it is listed so a reviewer does not
read it as a leak.

Land this task **on its own** — `ops-ui.html` is the codebase's busiest merge surface.

**Tests:** Playwright — ops sees approve on a qualifying quote and not on a chauffeur or two-leg
quote; ops sees no send-back, reopen-sent, zone or delete-locked controls; **ops's queue layout
and headline copy are byte-identical to today**; founder's view is unchanged throughout.

### Task 5: Update the quote-lifecycle user stories

**Depends on:** Task 4. Docs only — no `npm run check` gate, but it is **not optional**: without it
the repo's declared source of truth for this lifecycle is wrong the moment Task 2 merges, which is
precisely the failure its own header warns about ("Regenerate this if the lifecycle code changes").

**Files:** `docs/quote-lifecycle-user-stories.md`

**Do not patch the five lines below — re-read the doc against current code first.** It is stamped
`main @ 9096a1c (2026-07-18)`, and partial pay links, manual discounts and revision history have
all shipped since. Assume it already lags independently of this change; the header's date is a
claim, not a guarantee.

What this change alone makes wrong:

- **The cast (3 actors) becomes 4.** "Support = Finance **or** Ops … identical for the lifecycle"
  is no longer true: only Ops gains `quote:approve_simple`. Finance keeps `quote:manage` and gains
  nothing. Split them.
- **Founder is "the only approver"** → the only *unconditional* approver.
- **State map**: the `* = founder-only` marker on `approve` no longer holds for all quotes.
- **⛔#3** "Support cannot approve … founder-only" → conditionally false for Ops.
- **⛔#4** "everything passes through founder approval" → false for the qualifying class. The
  transition claim beside it stays true: `draft → sent` is still illegal.

New stories to add under ✅ *Possible & allowed*, as a sibling to #2 "Founder solo":

1. **Ops solo, simple transfer.** Build → record the customer request → **submit** → approve their
   own submission → mark sent. Note the submit hop: `draft → ready` has not existed since
   2026-07-19, so ✅#2 "Founder solo … self-approve (`draft -> ready`)" in the doc being edited is
   **itself stale** — a concrete instance of why this task re-reads rather than patches.
2. **Ops mints the pay link** on their own self-approved quote; the customer pays.
3. **Ops converts it** to a linked booking (Mark booked).
4. **Simplification unlocks self-approval.** A chauffeur or multi-leg quote sent back and edited
   down to a single standard leg now qualifies. The rule reads the quote as it stands at approval,
   never its history.

Confirm and keep as still-true: 🟡#2 (backend permits ops `ready → draft`, unexposed in the UI) is
unchanged **and still safe** — re-approval re-runs the predicate, so an ops agent cannot reopen a
self-approved quote, add legs, and re-approve it.

---

## Deferred: two legs

A later, separate step. **It must ship with an "all legs same date" companion rule**, and that is
not a nicety: private pricing ignores dates entirely — the private branch prices `legs`
point-to-point with no day rate and no idle km (`internalQuote.ts:404`), and the chauffeur guard
only pushes *down* (≥2 distinct dates → chauffeur *unless* service is explicitly `private`,
`:384`). So a bare two-leg allowance would let a genuine two-day job be self-approved priced as two
independent transfers — no overnight, no positioning, no deadhead. That is the same underquote the
code already guards against in the other direction at `:386`.

With the same-date rule, two legs means "there and back in a day", which is the intended shape.
Revisit the dollar ceiling at the same time.

## Rollout

Merges to `main` → staging on the usual pipeline. Watch a few real ops self-approvals on staging
before the `main → production` promote. No migration, so nothing auto-applies on boot.

**Rollback:** revert PR through staging → promote. There is no runtime switch, by decision 6.

## Self-Review

**Rule coverage:** clauses 1–5 → Task 1; enforcement → Task 2; surfacing → Tasks 3, 4; the
lifecycle record → Task 5.

**What this plan deliberately does not do:** add a role (ops already holds `quote:manage`, so the
quoting half needs no work), add a dollar ceiling, notify the founder, add a config flag, or touch
pricing, schema or generated files.

**The one thing a reviewer should check hardest:** that Task 1's fixtures came from a real `/save`
and that the custom-`$`/km case is present and genuinely red before the fix. Everything else in
this plan fails closed; that case is the only one that fails open.

**The one thing an implementer will get wrong:** Task 4's duplicate `isApprover()`. Both defects
this plan now guards against — the `tool`/`engine` field-name split and the two same-named UI
functions — are the same species: a name that looks singular and isn't. Re-grep before editing
either.

**Findings folded in 2026-08-11 after a review pass against the code**, not present in the first
draft: the payment reach in decision 5 (approval gates the pay-link mint, so this is a
money-out-the-door permission, not a status permission), and the whole of Task 4's shape. The
first draft named `2416` as the only UI site and would have shipped a no-op.
