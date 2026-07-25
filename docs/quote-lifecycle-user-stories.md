# Ceylon Hop — Quote Lifecycle: User Stories (possible / allowed / blocked)

**Reflects `main` @ `9096a1c` (2026-07-18).** Source of truth for the ops quoting maker-checker
lifecycle: which workflows the system supports, which are permitted, and which are blocked (by
design or by gap). Regenerate this if the lifecycle code changes.

Code anchors: transitions `api/src/db/quoteRepo.ts`; route gates `api/src/routes/internalQuote.ts`
(`/save` editability, `PATCH /:id` transitions); UI action bar `api/src/routes/ops-ui.html`
(`renderActionBar`); auto-expiry `api/src/services/quoteExpiry.ts`.

## The cast (3 actors)
- **Founder** — the only approver (`quote:approve`), and the only one who sees margin/cost.
- **Support** = **Finance** or **Ops** — can build, price, save, submit, send, and record
  outcomes, but **cannot approve** and never see margin. Identical for the lifecycle.
- **System / cron** (`x-admin-key`) — **no quote access at all**; drives only the expiry sweep.

## State map
```
   [record requestedService] ──required before pending_review / ready──┐
                                                                       v
  draft ──submit──> pending_review ──approve*──> ready ──send──> sent ──(idle 30d)──> expired
    |  ^   <-sendBack*--+  |  |                    |              |
    |  +-- resubmit -- changes_requested           |              |
    |           (editable)  |                      |              |
    +---- approve* (self, founder) ----------------+              |
   reopen-to-draft: from pending_review (either role), ready/sent (founder only)
   outcome won/lost: from any live state except draft ---------------> [terminal]
   * = founder-only        content-editable only in: draft, changes_requested
```

## Two gates that shape everything
1. **`requested_service_required` (400).** Cannot reach `pending_review` or `ready` until
   `requestedService` ("what the customer asked for": private | chauffeur | both) is recorded.
   Checked against the stored row; only `POST /save` writes it. Mirrored client-side (the
   Submit/Approve buttons are disabled with a hint until it's set). Not applied to `/save`.
2. **Content freeze on submission.** `POST /save` accepts edits only while status is
   **`draft` or `changes_requested`**. Submitting freezes content — the founder reviews exactly
   what was submitted; the only way back to editing is an explicit reopen-to-draft.

---

## ✅ Possible & allowed
1. **Two-person maker-checker.** Support builds -> records the customer request -> **Submit for
   review** (content now frozen) -> Founder reviews the exact submission -> **Approve** ->
   **Mark as sent** -> **Mark booked / lost**.
2. **Founder solo.** Build -> record request -> **self-approve** (`draft -> ready`) -> send ->
   outcome. (Self-approve is also gated on `requestedService`.)
3. **Revision loop.** Founder **Send back** -> `changes_requested` (editable again) -> fix ->
   **Resubmit** -> approve. Bounces as many times as needed.
4. **Pull back from review to fix (either role).** A quote in `pending_review` needs a change ->
   **Reopen to edit** -> back to `draft`, editable. Support can do this too, not just the founder.
5. **Fix an approved quote before sending (founder).** `ready` -> **Reopen to edit** -> drops the
   rate lock and reprices against the live card -> fix -> re-approve.
6. **Pull back after sending (founder only).** `sent` -> **Reopen to edit** -> edit -> re-approve
   -> resend.
7. **Record the outcome.** From `sent`: **Mark booked** (`won`) or **Mark lost** (with a reason).
8. **Auto-expiry (no human).** A `sent` quote nobody books goes `expired` after 30 idle days
   (anchored on `sentAt`; ops quotes only — web quotes are out of scope).

## 🟡 Allowed by the backend, hidden in the UI (latent)
1. **Outcome from earlier states.** The backend allows `won`/`lost` from any live non-draft state,
   but the UI only surfaces Mark booked/lost at `sent`. You can't record a "won" on a quote
   accepted while still in review without first marking it sent.
2. **Support reopening a `ready` quote.** The backend permits `ready -> draft` without approve,
   but the UI gives support only **Mark as sent** at `ready` (no reopen). (Support reopening
   `pending_review` *is* exposed — only `ready` isn't.)

## ⛔ Blocked by design (guardrails)
1. **Can't submit or approve without recording the customer request** — `400
   requested_service_required`.
2. **Can't edit content once submitted** — `409 not_editable` in `pending_review`/`ready`/`sent`;
   must reopen first.
3. **Support cannot approve, send back, or reopen a *sent* quote** — founder-only
   (`403 approve_forbidden`).
4. **No skipping approval** — `draft -> sent` is not a legal transition; everything passes through
   founder approval.
5. **A bare draft can't be an outcome** — `draft -> won/lost` is blocked.
6. **Terminal is forever** — `won` / `lost` / `expired` have no exits (no un-win, no reopen a lost
   quote; a returning "lost" customer means a new quote).

## 🚧 Remaining gap
- **`convertedBookingId` / quote -> booking link.** Currently a `won` quote has no link to the
  booking it became. Being built on an in-flight branch: once merged, **Mark booked** stops being
  a bare status flip and instead **creates a linked booking** (into `payment_pending`), adding a
  new allowed story ("book this quote -> a real booking exists, linked both ways"). This is the
  last quote-lifecycle sharp edge to close.
