# Editing a quote that is in review

Date: 2026-08-20
Owner ask: "a quote should be editable by an ops role anytime before it's ready to send."
Owner follow-up (2026-08-22): "as long as it's not sent to customer an ops person should be
able to reopen." — extends §4.7 below to the `ready` state.

## 1. Problem

A quote's statuses before **Ready to send** (`ready`) are `draft` → `pending_review` →
(`changes_requested`). Content is editable in `draft` and `changes_requested` only:

- server — `POST /internal/quotes/save` 409s `not_editable` for anything else
  (`api/src/routes/internalQuote.ts:857`)
- client — `isEditableNow()` returns true for those two states; `applyContentLock()` disables
  every input in the builder otherwise (`api/src/routes/ops-ui.html:4718`)

So **`pending_review` is the only gap** in the owner's ask. It is frozen by the review lock
(owner decision, 2026-07-17): submission freezes content so the founder approves exactly what
they reviewed.

There is already a door: ops-role users get a **"Reopen to edit"** button on `pending_review`
(`ops-ui.html:8177`) which drops the quote to `draft`, no approver needed. The friction is that
it is a separate deliberate click on a greyed-out screen, and it silently yanks the quote out of
the founder's queue with no explanation on the way in.

This spec removes that friction **without giving up the review-lock guarantee**.

## 2. Decision

Editing a `pending_review` quote is allowed, and **the first edit pulls the quote back to
`draft`**. The quote leaves the founder's review queue at that moment and must be resubmitted.

Rejected alternatives:

- *Edit in place, stay in the queue, flag "edited since submitted"* — keeps queue position but
  demotes the freeze from an invariant to a warning, and needs a new stored column (schema
  change, migration, prod gate) for a problem the pull-back solves with none.
- *Edit in place, no flag* — removes the 2026-07-17 guarantee outright: a founder could approve
  a version they never saw, silently.
- *Do nothing; make "Reopen to edit" louder* — the button is not the complaint; being sent to a
  dead screen first is.

## 3. Scope

**Front-end only — `api/src/routes/ops-ui.html`.** No server rule change, no schema, no
migration, no config. `pending_review → draft` is already a legal transition
(`api/src/db/quoteRepo.ts:21`), already un-gated for ops (only `→ ready`,
`→ changes_requested` and reopening a `sent` quote need `quote:approve`), drops no rate lock,
and sends no email.

Leaving `POST /save` refusing `pending_review` is deliberate: it keeps "the founder approves
exactly what they reviewed" a **server-enforced invariant** rather than a client convention.
The client's job is to make the status honest *before* it saves, not to bypass the rule.

Also in scope (owner follow-up): giving an ops-role user the **"Reopen to edit"** button on a
`ready` quote, which they do not have today (`ops-ui.html:8166`). This needs no server change
either — only reopening a **`sent`** quote is founder-gated (`reopeningSent`,
`internalQuote.ts:1532`); `ready → draft` is already accepted from an ops session, so today's
lock is cosmetic and the button is the whole fix.

Out of scope: `sent`. Reopening a quote the customer already has stays founder-only — that is
the owner's line.

## 4. Behaviour

1. A `pending_review` quote opens with a **live editor** — inputs, chips and the pricing
   chooser all enabled, save chip visible.
2. The existing amber review banner (`renderReviewBanner`, `ops-ui.html:8351`) states the
   consequence up front, before anything is touched:
   - approver: **"In review"** — *"Approve, send back, or just start editing — editing pulls it
     back to draft."*
   - ops: **"Submitted — with the founder"** — *"Start editing and it comes back to you as a
     draft to resubmit."*
3. The first content edit fires the pull-back: it first re-reads the quote's status with the
   server (a founder can approve or send it from elsewhere while this tab still shows
   `pending_review`), and only if that confirms it is still `pending_review` does it
   `PATCH {status:'draft'}` and toast **"Pulled back out of review — resubmit when you're
   done."** The queue row moves, the action bar swaps to *Submit for review*, and the banner
   becomes the normal draft one. If the status has already moved on, no PATCH fires at all —
   see §5.2.
4. The edit then saves through the usual autosave path.
5. If the pull-back PATCH fails, the editor **re-locks**, the edit is not saved, and the toast
   names the reason (`"Could not pull this back out of review — <reason>"`).
6. **"Reopen to edit" keeps the same role** — the door for pulling a quote back *without*
   editing it (e.g. to park it), and the fallback when the automatic pull-back fails. §4.7 below
   adds a confirm step in front of it when a pay link is out; that changes what a press of the
   button does on a `ready`/`sent` quote with a link out, not what the button is for.

This applies to **everyone in the ops app**, ops and founders alike — editability stays keyed on
status, never on role, as it is everywhere else today. A founder who starts typing mid-review
pulls the quote back too; that is the honest outcome, because they are changing it, not
reviewing it.

7. On a **`ready`** quote an ops-role user gets the same **"Reopen to edit"** button the
   approver already has — identical placement, copy and behaviour, no longer role-hidden. It is
   deliberately the *explicit button*, NOT the type-and-it-pulls-back behaviour of §4.3:
   reopening an approved quote drops its frozen rate card and re-prices at today's rates
   (`internalQuote.ts:1557`), so a stray keystroke silently moving an approved price is a
   different order of consequence from leaving a review queue. Post-review addition (owner
   decision): if a pay link is out on the current `ready`/`sent` quote — either because the
   server has already stamped `state.customerTotalVia === 'pay_link'`, or because one was minted
   in this session and not yet echoed back (`_payLink` set but no refetch has happened) — the
   button confirms before it fires, since reopening would make that link `unavailable`
   mid-checkout (`stateFor()`, `quotePay.ts:175`, serves only `ready`/`sent`), and aborts on
   cancel. It does not fire on `pending_review` even with `customerTotalVia === 'pay_link'` set:
   `stateFor()` already returns `unavailable` there, so the link is already dead and the warning
   would be false. A `ready`/`sent` quote with no link out is unaffected and stays a single
   click. This gate has a known gap — see §6.

No notification fires to the founder whose queue item was pulled — matching what "Reopen to
edit" does today.

## 5. Mechanics

### 5.1 Split the editability predicate

`isEditableNow()` is doing two different jobs today. Split them:

| predicate | means | states |
|---|---|---|
| `isEditableNow()` | the content editor is live | `draft`, `changes_requested`, **`pending_review`** |
| `isSavableNow()` (new) | the server will accept `POST /save` | `draft`, `changes_requested` |

Widening `isEditableNow()` alone would break **Approve**: `transition()` flushes a save first
when `isEditableNow()` (`ops-ui.html:5612`), so approving from `pending_review` would start
POSTing to `/save`, take a 409, and abort the transition — the exact bug commit `3d93b56`
fixed. That call site must move to `isSavableNow()`.

Audit of the other `isEditableNow()` call sites — all are content/UI concerns and are correct
once widened: `discountEditable` (4281), `applyContentLock` (4730), `renderSaveState` (4780),
⌘S (9713), vehicle number-keys (9738), route-choice prompt (9851), palette actions (10867–8).
The submit-blockers "locked while in review" copy (8313) now only reaches non-editable states,
so its sentence drops the "while in review" clause.

### 5.2 The pull-back

`markDirty()` is the single funnel every content mutator already goes through — that is the
hook:

```
function markDirty() {
  if (state.status === 'pending_review') pullBackFromReview();
  _dirty = true; _autoState = 'idle'; armAutosave(); updateSaveChip();
}
```

`pullBackFromReview()` is **idempotent per quote**. Its in-flight promise lives in `_pullbacks`,
a map keyed by quote id — not a single module-level slot: a slot can only ever remember one
quote's pull-back, so a burst of typing on quote A, a detour to quote B (also `pending_review`)
before A's PATCH lands, and back to A again would fire a second PATCH for A. The map gives every
quote its own entry: `pendingPullback()` reads `_pullbacks[state.savedId]` for whichever quote is
open now, `pullBackFromReview()` returns the existing entry for `id` if one is already in flight,
claims the slot synchronously before its async work starts, and releases it in `.finally()` by
promise **identity** (`_pullbacks[id] === p`), not by id alone, so a newer pull-back that has
since claimed the same id is never evicted by an older one settling late.

Before PATCHing, the resolution re-reads the quote with `apiGetQuote(id)` and checks its status
is still `pending_review`. Nothing here polls — `state.status` is written only by
`reopenQuote()`/`saveQuote()`/`transition()` — so a founder approving or sending the quote from
elsewhere leaves this tab still reading `pending_review`, and PATCHing blind would move it to
`draft` from wherever it actually is now (dropping the frozen rate card, for `ready`). If the
re-read finds anything other than `pending_review`, this is **not** a pull-back failure — nothing
broke, the quote is just no longer in review — so `_pullbackFailed` (which means exactly "the
pull-back failed") stays untouched; instead `state.status` adopts the real status and the toast
names it ("...now ready) — use 'Reopen to edit' if you still want to change it"). Only once the
re-read confirms `pending_review` does the `PATCH {status:'draft'}` fire.

Both the GET and the PATCH cross an await, and the operator is free to open a different quote
before either resolves. The resolution captures `var seq = _openSeq;` once, before the GET, and
rechecks `if (seq !== _openSeq)` after each await — not just the PATCH's: on a generation
mismatch, `state.status`, `_pullbackFailed`, the toast and `render()` are all skipped (they would
describe the wrong quote). The queue-level sync (`opsUpsertQuote`/`opsRefreshQuotes`, keyed by
`id` not `state`) still runs unconditionally after the PATCH regardless of `seq`, and a PATCH
failure is still reported via `opsReportError` rather than silently dropped; a stale-generation
GET failure or moved-on result has nothing to sync and is beaconed (GET failure) or simply
dropped (moved-on — nothing failed, nothing to report) instead. On PATCH success it sets
`state.status = 'draft'`, toasts, and `render()`s. On PATCH failure it sets `_pullbackFailed =
true` and re-locks (`isEditableNow()` reads the flag). A GET failure (network error, etc.) is
treated the same as a PATCH failure — `_pullbackFailed = true`, same toast shape, never PATCHes
blind.

Calling `render()` mid-typing is safe: `render()` diff-renders and already snapshots and
restores the focused field's in-progress text and caret (`captureEditorFocus` /
`restoreEditorFocus`).

### 5.3 Ordering guarantee

An edit must never reach `/save` before the status PATCH lands, or it eats a `not_editable`
409. `saveQuote()`, `fireAutosave()` and `transition()` are the three funnels that can reach
`/save` or issue a competing status PATCH, and each carries the same hand-placed guard around its
own await of the current quote's pull-back:

```
var seq = _openSeq;
var pb = pendingPullback();
if (pb) await pb;
if (seq !== _openSeq) return false; // a different quote is open now — bail before touching state
if (!isSavableNow()) return false;
```

`seq` is captured before the await and reused (not re-captured) after it — a reopen landing
mid-await must be caught before the resumed call reads or writes `state`, which may belong to a
different quote by then. This is the file's general idiom for "am I still on the same quote after
an await" — every await in the edit path follows the same seq/await/recheck shape, not just the
pull-back's own.

`fireAutosave()`'s own gate becomes `isSavableNow()` for the same reason, and additionally
re-arms (rather than returning bare) when a failed pull-back leaves typed content unsaved, up to
a bounded retry count, so manual recovery ("Reopen to edit") doesn't strand the typing until the
next keystroke. The 2.5s autosave debounce means the PATCH almost always lands first anyway — the
await is what makes it a guarantee rather than a race.

## 6. Risks

**A `markDirty()` on load would silently pull a quote out of review.** This is the one real
hazard. Hydration deliberately does not call it (`ops-ui.html:5498`: "Never markDirty(): the
server stored exactly this"), and this is pinned by a test (§7).

**A founder loses their place in the queue by mis-typing.** Accepted, with the banner as the
warning and the toast as the receipt. "Reopen to edit" is still there, and resubmitting is one
click.

**"Not sent" is not the same as "the customer has not seen the price".** A `ready` quote can
already have a pay link minted against it, which puts a number in the customer's hands without
the quote ever reaching `sent` — that is precisely why `customer_total_at` is stamped by a
pay-link mint as well as by mark-sent (spec 2026-08-05 §9). Ops reopening such a quote re-prices
it and stops that link resolving (`stateFor()`, `quotePay.ts:175`, serves only `ready`/`sent`).
Mitigated after review, not merely accepted: "Reopen to edit" now confirms first whenever a link
is out (§4.7), so the operator gets a chance not to make that move by accident. The customer can
never be charged the *wrong amount* either way — the pay token pins `revision`, so a post-reopen
save just resolves the link to `revised` — the hazard this closes is availability, not price.

**Known gap, still open — the confirm can be silently defeated by ordering.**
`customer_total_at` (and with it `customerTotalVia`) is stamped only when the total *differs*
from the recorded baseline (`internalQuote.ts:1215-1218`) — it is a "did the number change"
signal, not a "has a customer-facing link gone out" signal, and that mismatch has a real gap in
it. Minting the **quote** link first (stamps `via:'quote_link'` at total T), then the **payment**
link at the same T (T === T, no stamp — nothing changed), defeats the confirm even across a page
reload: `customerTotalVia` never becomes `'pay_link'`, `_payLink` is gone after the reload, and
"Reopen to edit" fires with no prompt while a live payment link is still out. The same happens
with "Mark as sent" first, then a pay link minted against the now-`sent` row. `payLinkSeq` is not
a usable substitute either — it stays `0` for a first, full-total mint, so it can't distinguish
"never minted" from "minted once." Closing this needs a durable, server-side "a payment link is
currently live" signal (not a derived-from-total-change flag), which is a schema-touching change
outside a front-end-only branch's constraints. Left open, deliberately — §4.7's confirm covers
the common within-session case, not this one.

**Concurrent approval — closed for the stray keystroke, unchanged for the deliberate click.** If
the founder approves between a keystroke and the pull-back's PATCH, the pull-back (§5.2) now
re-reads the quote's status first and finds `ready`; it aborts instead of PATCHing `ready →
draft`, adopts the real status into `state`, and tells the operator the quote moved on. The
approval survives. This does **not** apply to the explicit "Reopen to edit" button, which still
PATCHes `ready → draft` on a deliberate press (now with the pay-link confirm above) — only the
automatic, type-and-it-pulls-back path was the hazard, and only that path is closed. A
concurrently *deleted* quote still 404s and hits the failure path (§4.5).

## 7. Tests

`api/src/routes/opsUi.test.ts` — the review-lock block (`:566`) asserts the old behaviour as
source-string scans and gets rewritten:

- `isEditableNow()` includes `pending_review`; a new `isSavableNow()` does not
- `transition()`'s flush gate reads `isSavableNow()`, not `isEditableNow()`
- `saveQuote()` awaits `pendingPullback()` (this quote's entry) and bails on `!isSavableNow()`
- `markDirty()` triggers `pullBackFromReview()` on `pending_review`
- the quote-load path contains no `markDirty()` (the §6 hazard)
- `applyContentLock` no longer disables the editor in `pending_review`
- "Reopen to edit" is still on the `pending_review` action bar for both roles
- "Reopen to edit" is now on the `ready` action bar for the non-approver role too, and is still
  absent from `sent` for that role (the owner's line)
- the §4.7 pay-link confirm fires for a link minted THIS session (`_payLink`, no server stamp yet)
  and stays silent on `pending_review`, where the link is already `unavailable` — both pinned
  behaviourally in `web-tests/e2e/quote-approval.spec.js`, since the source-scan form of this one
  can be satisfied by the explanatory comment inside `reopenToDraft`

Server tests are unchanged: `POST /save` must still 409 `not_editable` for `pending_review`
(`internalQuote.test.ts`), and that assertion is now load-bearing — it is the invariant this
design leans on.

Gate: `cd api && npm run check` plus `npm run test:all` in `web-tests/`.
