# Ceylon Hop — Quote Lifecycle: User Stories (possible / allowed / blocked)

**Reflects `main` @ `41fbca8` (2026-08-12).** Source of truth for the ops quoting maker-checker
lifecycle: which workflows the system supports, which are permitted, and which are blocked (by
design or by gap). Regenerate this if the lifecycle code changes.

> **Re-read before trusting this file.** The previous revision was stamped 2026-07-18 and was
> wrong in five places by the time it was next opened: it still showed a `draft → ready`
> self-approve that had been removed the following day, put auto-expiry at 30 days when it was
> raised to 180, called the quote→booking link an unbuilt gap after it shipped, said terminal
> states have no exits after `expired → draft` was added, and described a three-actor cast that
> ops self-approval has since split. A header date is a claim, not a guarantee — check the code.

Code anchors: transitions `api/src/db/quoteRepo.ts` (`ALLOWED_TRANSITIONS`); route gates
`api/src/routes/internalQuote.ts` (`/save` editability, `PATCH /:id` transitions); the
self-approval predicate `api/src/quote/simpleApproval.ts`; UI action bar
`api/src/routes/ops-ui.html` (`renderActionBar`); auto-expiry `api/src/services/quoteExpiry.ts`.

## The cast (4 actors)
- **Founder** — the unconditional approver (`quote:approve`), and the only one who sees
  margin/cost or may apply a discount (`discount:apply_manual`).
- **Ops** — builds, prices, saves, submits, sends, records outcomes, **and since 2026-08-11 may
  approve its own simple work** (`quote:approve_simple`, see the third gate below). Never sees
  margin.
- **Finance** — builds, prices, saves, submits, sends, records outcomes. **Cannot approve
  anything.** Never sees margin.
- **System / cron** (`x-admin-key`) — **no quote access at all**; drives only the expiry sweep.

Ops and Finance were one "Support" actor in earlier revisions of this doc. They are not
interchangeable any more: only Ops holds `quote:approve_simple`.

## State map
```
   [record requestedService] ──required before pending_review / ready──┐
                                                                       v
  draft ──submit──> pending_review ──approve*──> ready ──send──> sent ──(idle 180d)──> expired
    |  ^   <-sendBack*--+  |  |                    |              |                       |
    |  +-- resubmit -- changes_requested           |              |                       |
    |           (editable)  |                      |              |                       |
    +<--------- reopen-to-draft --------------------------------------------------------- +
   reopen-to-draft: from pending_review (either role), ready (backend allows either role,
                    UI founder-only), sent (founder only), expired (either role)
   outcome won/lost: from any live state except draft ---------------> [terminal]
   * = founder-only, EXCEPT approve, which Ops may also do on a qualifying quote (gate 3)
   content-editable only in: draft, changes_requested
```

**There is no `draft → ready`.** The founder-only "self-approve straight from a draft" shortcut
was removed 2026-07-19. `ready` is reachable **only** from `pending_review`, for everyone. So even
a solo quote passes through submission — which is what makes the content freeze meaningful.

## Three gates that shape everything
1. **`requested_service_required` (400).** Cannot reach `pending_review` or `ready` until
   `requestedService` ("what the customer asked for": private | chauffeur | both) is recorded.
   Checked against the stored row; only `POST /save` writes it. Mirrored client-side (the
   Submit/Approve buttons name what is missing until it's set). Not applied to `/save`.
2. **Content freeze on submission.** `POST /save` accepts edits only while status is
   **`draft` or `changes_requested`**. Submitting freezes content — the approver reviews exactly
   what was submitted; the only way back to editing is an explicit reopen-to-draft.
3. **The self-approval predicate** (`canOpsSelfApprove`, 2026-08-11). Ops may take a quote to
   `ready` only when **all five** hold: `product === 'private'` · exactly one leg in the stored
   **engine** request · vehicle is not `custom` · no hand-set $/km · no active discount. Evaluated
   on the stored row, never the request body — and gate 2 means that row is frozen, so what the
   predicate reads is what was submitted. Everything else stays founder-only.

---

## ✅ Possible & allowed
1. **Two-person maker-checker.** Ops or Finance builds -> records the customer request ->
   **Submit for review** (content now frozen) -> Founder reviews the exact submission ->
   **Approve** -> **Mark as sent** -> **Mark booked / lost**.
2. **Founder solo.** Build -> record request -> **Submit for review** -> **Approve** -> send ->
   outcome. Two hops, not one: there is no draft→ready shortcut for anyone.
3. **Ops solo, on a simple transfer** (2026-08-11). Build -> record request -> **Submit for
   review** -> **approve their own submission** -> send -> mint the pay link -> **Mark booked**.
   Only for a quote that satisfies gate 3. Nobody else is involved at any hop, and no
   awaiting-approval mail is sent — the founder learns of it from `quote_revisions`
   (`status` + `updatedBy`), not a notification.
4. **Simplification unlocks self-approval.** A chauffeur or multi-leg quote sent back and edited
   down to a single standard leg now qualifies for story 3. The gate reads the quote as it stands
   at approval, never its history.
5. **Revision loop.** Founder **Send back** -> `changes_requested` (editable again) -> fix ->
   **Resubmit** -> approve. Bounces as many times as needed. Send-back stays founder-only:
   ops self-approval grants Approve and nothing else.
6. **Pull back from review to fix (either role).** A quote in `pending_review` needs a change ->
   **Reopen to edit** -> back to `draft`, editable. Ops and Finance can do this too.
7. **Fix an approved quote before sending (founder).** `ready` -> **Reopen to edit** -> drops the
   rate lock and reprices against the live card -> fix -> re-approve.
8. **Pull back after sending (founder only).** `sent` -> **Reopen to edit** -> edit -> re-approve
   -> resend.
9. **Revive an expired quote (either role).** `expired` -> **Reopen to edit** -> `draft`.
   Deliberately NOT founder-gated, unlike pulling back a `sent` quote: nobody chose to close it,
   a background sweep did, so restoring it undoes the system's action rather than overriding a
   person's. It re-prices at the live card, so a revived quote can never carry a stale price.
10. **Record the outcome.** From `sent`: **Mark booked** (`won`) or **Mark lost** (with a reason).
    Mark booked creates a real linked booking and stamps `converted_booking_id` — it is not a bare
    status flip, and it is idempotent on the quote id.
11. **Auto-expiry (no human).** A `sent` quote nobody books goes `expired` after **180 idle days**
    (anchored on `sentAt`; ops quotes only). Raised from 30 (owner, 2026-07-31) — at 30 the sweep
    would have started closing real, live work inside a fortnight.

## 🟡 Allowed by the backend, hidden in the UI (latent)
1. **Outcome from earlier states.** The backend allows `won`/`lost` from any live non-draft state,
   but the UI only surfaces Mark booked/lost at `sent`. You can't record a "won" on a quote
   accepted while still in review without first marking it sent.
2. **Ops/Finance reopening a `ready` quote.** The backend permits `ready -> draft` without
   `quote:approve`, but the UI gives a non-approver only **Mark as sent** at `ready` (no reopen).
   Reopening `pending_review` *is* exposed — only `ready` isn't. Still safe alongside ops
   self-approval: re-approval re-runs gate 3, so an ops agent cannot reopen a self-approved quote,
   add legs, and approve it again.

## ⛔ Blocked by design (guardrails)
1. **Can't submit or approve without recording the customer request** — `400
   requested_service_required`.
2. **Can't edit content once submitted** — `409 not_editable` in `pending_review`/`ready`/`sent`;
   must reopen first.
3. **Finance cannot approve anything; Ops cannot approve anything but a qualifying simple
   transfer** — `403 approve_forbidden`. Send back, reopening a *sent* quote, hot-zone edits and
   deleting a locked quote all remain founder-only (`quote:approve`), for both.
4. **No skipping approval** — `draft -> sent` is not a legal transition. Every quote passes
   through `pending_review` and an explicit approval; what changed in 2026-08-11 is *who* may give
   that approval on a simple transfer, not whether one is required.
5. **A bare draft can't be an outcome** — `draft -> won/lost` is blocked.
6. **`won` and `lost` are forever** — no un-win, no reopening a lost quote; a returning "lost"
   customer means a new quote. `expired` is **not** terminal (see story 9).
7. **Only the founder may discount** — `discount:apply_manual`. A discounted quote also drops out
   of ops self-approval by gate 3.

## Not covered by this document
Shipped lifecycle-adjacent features this file deliberately does not describe, so that its absence
is not read as their absence: founder manual discounts, customer-facing quote links (`/q`), quote
version history (`quote_revisions`), the price-drift indicator, and partial-leg pay links. Each
has its own spec under `docs/superpowers/specs/`.
