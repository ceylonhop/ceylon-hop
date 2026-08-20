# Editing a quote that is in review

Date: 2026-08-20
Owner ask: "a quote should be editable by an ops role anytime before it's ready to send."

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

Out of scope: `ready`. An ops-role user still cannot edit or reopen an approved quote — reopen
from `ready` stays approver-only (`ops-ui.html:8166`). "Before ready to send" read literally.

## 4. Behaviour

1. A `pending_review` quote opens with a **live editor** — inputs, chips and the pricing
   chooser all enabled, save chip visible.
2. The existing amber review banner (`renderReviewBanner`, `ops-ui.html:8351`) states the
   consequence up front, before anything is touched:
   - approver: **"In review"** — *"Approve, send back, or just start editing — editing pulls it
     back to draft."*
   - ops: **"Submitted — with the founder"** — *"Start editing and it comes back to you as a
     draft to resubmit."*
3. The first content edit fires the pull-back: `PATCH {status:'draft'}`, then toast
   **"Pulled back out of review — resubmit when you're done."** The queue row moves, the action
   bar swaps to *Submit for review*, and the banner becomes the normal draft one.
4. The edit then saves through the usual autosave path.
5. If the pull-back PATCH fails, the editor **re-locks**, the edit is not saved, and the toast
   names the reason (`"Could not pull this back out of review — <reason>"`).
6. **"Reopen to edit" stays exactly as it is** — the door for pulling a quote back *without*
   editing it (e.g. to park it), and the fallback when the automatic pull-back fails.

This applies to **everyone in the ops app**, ops and founders alike — editability stays keyed on
status, never on role, as it is everywhere else today. A founder who starts typing mid-review
pulls the quote back too; that is the honest outcome, because they are changing it, not
reviewing it.

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

`markDirty()` (`ops-ui.html:4813`) is the single funnel every content mutator already goes
through — that is the hook:

```
function markDirty() {
  if (state.status === 'pending_review') pullBackFromReview();
  _dirty = true; _autoState = 'idle'; armAutosave(); updateSaveChip();
}
```

`pullBackFromReview()` is **idempotent** — it parks its in-flight promise in a module-level
`_pullback` and returns that same promise for every subsequent keystroke, so a burst of typing
fires exactly one PATCH. On success it sets `state.status = 'draft'`, calls `opsUpsertQuote` +
`opsRefreshQuotes`, toasts, and `render()`s. On failure it restores `state.status` and re-locks.

Calling `render()` mid-typing is safe: `render()` diff-renders and already snapshots and
restores the focused field's in-progress text and caret (`captureEditorFocus` /
`restoreEditorFocus`, `ops-ui.html:9111`).

### 5.3 Ordering guarantee

An edit must never reach `/save` before the status PATCH lands, or it eats a `not_editable`
409. `saveQuote()` (`ops-ui.html:5535`) is the single funnel to `/save`, so the guard goes at
its top:

```
if (_pullback) await _pullback;
if (!isSavableNow()) return false;
```

`fireAutosave()`'s own gate becomes `isSavableNow()` for the same reason. The 2.5s autosave
debounce means the PATCH almost always lands first anyway — the await is what makes it a
guarantee rather than a race.

## 6. Risks

**A `markDirty()` on load would silently pull a quote out of review.** This is the one real
hazard. Hydration deliberately does not call it (`ops-ui.html:5498`: "Never markDirty(): the
server stored exactly this"), and this is pinned by a test (§7).

**A founder loses their place in the queue by mis-typing.** Accepted, with the banner as the
warning and the toast as the receipt. "Reopen to edit" is still there, and resubmitting is one
click.

**Concurrent approval.** If the founder approves between the keystroke and the PATCH, the quote
is `ready` and `ready → draft` is still a legal, un-gated transition, so the pull-back succeeds
and the approval is undone. This is the same outcome as today's "Reopen to edit" race and needs
no new handling. A concurrently *deleted* quote 404s and hits the failure path (§4.5).

## 7. Tests

`api/src/routes/opsUi.test.ts` — the review-lock block (`:566`) asserts the old behaviour as
source-string scans and gets rewritten:

- `isEditableNow()` includes `pending_review`; a new `isSavableNow()` does not
- `transition()`'s flush gate reads `isSavableNow()`, not `isEditableNow()`
- `saveQuote()` awaits `_pullback` and bails on `!isSavableNow()`
- `markDirty()` triggers `pullBackFromReview()` on `pending_review`
- the quote-load path contains no `markDirty()` (the §6 hazard)
- `applyContentLock` no longer disables the editor in `pending_review`
- "Reopen to edit" is still on the `pending_review` action bar for both roles

Server tests are unchanged: `POST /save` must still 409 `not_editable` for `pending_review`
(`internalQuote.test.ts`), and that assertion is now load-bearing — it is the invariant this
design leans on.

Gate: `cd api && npm run check` plus `npm run test:all` in `web-tests/`.
