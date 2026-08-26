# Editing a quote in review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ops person change a quote at any point before the customer has been sent it — by typing directly on a quote that is in review, and by reopening one that is approved.

**Architecture:** Front-end only, all in `api/src/routes/ops-ui.html`. `pending_review` becomes content-editable on screen, and the first edit fires an idempotent `PATCH {status:'draft'}` that takes the quote out of the founder's review queue before any `/save` can run. The server rule is untouched — `POST /internal/quotes/save` still 409s `not_editable` for `pending_review`, which is precisely the invariant this design leans on. Separately, the `ready` action bar stops hiding its existing "Reopen to edit" button from non-approvers.

**Tech Stack:** Vanilla ES5-ish browser JS inside a server-rendered HTML string (`ops-ui.html`), Vitest source-scan tests (`api/src/routes/opsUi.test.ts`), Playwright e2e (`web-tests/e2e/`).

**Spec:** `docs/superpowers/specs/2026-08-20-edit-quote-in-review-design.md`

## Global Constraints

- **No server change.** Do not touch `api/src/routes/internalQuote.ts`, `api/src/db/quoteRepo.ts`, any schema, migration, or config. If a task seems to need one, stop and ask.
- **No pricing change.** Do not touch `rateCard.ts` or `departureRepo.ts`.
- **`sent` stays founder-only.** Never add a reopen affordance for a non-approver on a `sent` quote.
- **`ready` is never auto-pulled-back.** Only the explicit button. Reopening `ready` drops the frozen rate card and re-prices; no keystroke may cause that.
- Money stays integer minor units; no money code is touched here.
- Gate before every commit: `cd api && npm run check`, and `npm run test:all` from `web-tests/`.
- Commit one logical change at a time. Stage by explicit path — never `git add -A`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `api/src/routes/ops-ui.html` | Modify | All behaviour. Predicate split, the pull-back, the ordering guard, banner + blockers copy, the `ready` action bar row. |
| `api/src/routes/opsUi.test.ts` | Modify `:566-596` | Source-scan tests. The existing `ops UI — review lock` describe asserts the OLD behaviour and is replaced wholesale. |
| `web-tests/e2e/quote-approval.spec.js` | Modify `:283`, add 2 tests | Behavioural proof: editor live in review, pull-back fires once, ops reopen on `ready`. |
| `web-tests/e2e/ops-leg-card-layout.spec.js` | Modify `:59` | Its "locked quote" fixture is `pending_review`, which is no longer locked. Move it to `ready`. |

`ops-ui.html` is a single ~11k-line file by existing design. Do not split it.

---

### Task 1: Editing a quote in review pulls it back to draft

**Files:**
- Modify: `api/src/routes/ops-ui.html:4718-4722` (predicates), `:4757` (autosave gate), `:4813` (markDirty), `:5327` + `:6116` (flag reset), `:5535-5537` (saveQuote head), `:5612` (transition flush gate), `:8313-8315` (blockers copy), `:8357-8360` (banner copy)
- Test: `api/src/routes/opsUi.test.ts:566-596`, `web-tests/e2e/quote-approval.spec.js`, `web-tests/e2e/ops-leg-card-layout.spec.js:59`

**Interfaces:**
- Produces: `isEditableNow(): boolean` — the content editor is live. `isSavableNow(): boolean` — `POST /save` will accept it. `pullBackFromReview(): Promise<boolean>|null` — idempotent; resolves `true` when the quote reached `draft`. Module vars `_pullback: Promise|null`, `_pullbackFailed: boolean`.
- Consumes: existing `apiPatch(id, patch)` (`:5238`), `showToast(msg, kind)` (`:5275`), `render()` (`:9111`, focus-preserving), `window.opsUpsertQuote`, `window.opsRefreshQuotes`.

- [ ] **Step 1: Replace the review-lock test block with the new expectations**

In `api/src/routes/opsUi.test.ts`, delete the whole `describe('ops UI — review lock', ...)` block at `:566-596` (including its two-line `// Review lock (owner, 2026-07-17)` comment above it) and put this in its place:

```ts
// Editing in review (owner, 2026-08-22). The editor is LIVE in pending_review; the first edit
// PULLS THE QUOTE BACK to draft, so the founder can still never approve content they did not
// see. The server keeps refusing /save for pending_review — that 409 is the invariant this
// leans on, which is why the ordering assertions below are the important ones.
describe('ops UI — editing a quote in review', () => {
  let body: string;
  beforeAll(async () => { body = await (await createApp().request('/ops')).text(); });

  // Local copy: the file scopes this helper per-describe (see the unpriced-shell block).
  function fnBody(name: string): string {
    const start = body.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    let depth = 0; let i = body.indexOf('{', start);
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) break;
    }
    return body.slice(start, i + 1);
  }

  it('the editor is live in pending_review, but saving is not', () => {
    expect(fnBody('isEditableNow')).toContain("state.status === 'pending_review'");
    const savable = fnBody('isSavableNow');
    expect(savable).toContain("state.status === 'draft'");
    expect(savable).toContain("state.status === 'changes_requested'");
    expect(savable).not.toContain('pending_review');
  });

  it('the first edit pulls the quote back out of review', () => {
    expect(fnBody('markDirty')).toContain('pullBackFromReview()');
    expect(fnBody('pullBackFromReview')).toContain("{ status: 'draft' }");
  });

  it('one burst of typing fires exactly one PATCH', () => {
    expect(fnBody('pullBackFromReview')).toContain('if (_pullback) return _pullback;');
  });

  it('no edit can reach /save before the pull-back PATCH lands', () => {
    const save = fnBody('saveQuote');
    expect(save).toContain('if (_pullback) await _pullback;');
    expect(save).toContain('if (!isSavableNow()) return false;');
    expect(fnBody('fireAutosave')).toContain('if (!isSavableNow() || !state.vehicleType) return;');
  });

  it('a transition still flushes only what the server would accept', () => {
    // Widening this to isEditableNow() makes Approve POST /save, take a 409 and abort — the
    // bug commit 3d93b56 fixed. It must read the SAVABLE set, not the editable one.
    expect(fnBody('transition')).toContain('var editable = isSavableNow();');
  });

  it('a failed pull-back re-locks the editor rather than pretending edits are safe', () => {
    expect(fnBody('pullBackFromReview')).toContain('_pullbackFailed = true;');
    expect(fnBody('isEditableNow')).toContain('_pullbackFailed');
  });

  it('loading a quote never marks it dirty (it would silently pull it out of review)', () => {
    // reopenQuote() is the one path that hydrates a fetched quote into `state`. A markDirty()
    // anywhere in it would fire the pull-back on OPEN — every in-review quote a founder merely
    // looked at would leave their own queue. This is the sharpest hazard in the design (spec §6).
    expect(fnBody('reopenQuote')).not.toContain('markDirty()');
  });

  it('the banner warns before anything is touched, and no longer claims a lock', () => {
    expect(body).toContain('editing pulls it back to draft');
    expect(body).toContain('comes back to you as a draft to resubmit');
    expect(body).not.toContain('In review — locked');
    expect(body).not.toContain('Submitted — locked');
  });

  it('the reopen door is still on the pending_review action bar for both roles', () => {
    const bar = body.slice(body.indexOf('function renderActionBar('), body.indexOf('function renderReviewBanner('));
    const reviewRows = bar.split('\n').filter(l => l.includes("'pending_review'"));
    expect(reviewRows.length).toBeGreaterThanOrEqual(2); // approver + submitter rows
    reviewRows.forEach(row => expect(row).toContain('reopenToDraft'));
  });

  it('the editor still renders inert where it IS locked, with the map toggle exempt', () => {
    expect(body).toContain('function applyContentLock(');
    expect(body).toContain("classList.toggle('ch-locked', locked)");
    expect(body).toContain('viewing the route is not editing');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && npx vitest run src/routes/opsUi.test.ts -t "editing a quote in review"
```

Expected: FAIL. `fnBody('isSavableNow')` fails first on `expect(start).toBeGreaterThan(-1)` — the function does not exist yet.

- [ ] **Step 3: Split the editability predicate**

In `api/src/routes/ops-ui.html`, replace lines 4718-4722 in full:

```js
function isEditableNow() {
  // Review lock (owner, 2026-07-17): submission freezes content. pending_review is read-only —
  // the founder approves exactly what they reviewed; reopen-to-draft is the one door back in.
  return state.status === 'draft' || state.status === 'changes_requested';
}
```

with:

```js
// Content editability (owner, 2026-08-22, superseding the 2026-07-17 review lock). The EDITOR is
// live for every state before approval, pending_review included. The guarantee that a founder
// never approves content they did not see is now kept a different way: the first edit PULLS THE
// QUOTE BACK to draft (pullBackFromReview), so a changed quote is never sitting in the review
// queue. 'ready' stays locked on purpose — reopening it drops the frozen rate card and re-prices,
// which must be a deliberate button press and never a stray keystroke.
function isEditableNow() {
  if (state.status === 'pending_review') return !_pullbackFailed; // a failed pull-back re-locks
  return state.status === 'draft' || state.status === 'changes_requested';
}
// The states POST /save actually accepts (internalQuote.ts 409s not_editable otherwise). This is
// deliberately NOT the same set as isEditableNow: pending_review is editable on screen but must
// reach draft before anything can persist. Every path that talks to /save gates on THIS one.
function isSavableNow() {
  return state.status === 'draft' || state.status === 'changes_requested';
}
```

- [ ] **Step 4: Add the pull-back and hook it into markDirty**

In `api/src/routes/ops-ui.html`, replace line 4813 in full:

```js
function markDirty() { _dirty = true; _autoState = 'idle'; armAutosave(); updateSaveChip(); }
```

with:

```js
/* Pull-back (owner, 2026-08-22). Editing a quote that is with the founder takes it OUT of the
   review queue — the founder must never be able to approve content that changed after they read
   it. Idempotent: a burst of typing fires exactly ONE PATCH, because every caller after the first
   gets the same in-flight promise back. Never reached for 'ready' (markDirty cannot fire there —
   the editor is locked), which is the point: dropping a rate lock re-prices, and no keystroke
   should do that. */
var _pullback = null, _pullbackFailed = false;
function pullBackFromReview() {
  if (_pullback) return _pullback;
  var id = state.savedId;
  if (!id) return null; // nothing persisted yet — there is no review to leave
  _pullback = (async function () {
    var res = await apiPatch(id, { status: 'draft' });
    if (!res || res.error) {
      // Re-lock rather than let the operator keep typing into something that cannot save. The
      // explicit "Reopen to edit" button is still there as the manual way out.
      _pullbackFailed = true;
      showToast('Could not pull this back out of review — ' + ((res && res.error) || 'unknown error'), 'error');
      render();
      return false;
    }
    state.status = 'draft';
    if (window.opsUpsertQuote) window.opsUpsertQuote({ id: id, status: 'draft' });
    if (window.opsRefreshQuotes) window.opsRefreshQuotes();
    showToast('Pulled back out of review — resubmit when you\'re done');
    // Safe mid-keystroke: render() diff-renders and restores the focused field's in-progress
    // text and caret (captureEditorFocus / restoreEditorFocus).
    render();
    return true;
  })().finally(function () { _pullback = null; });
  return _pullback;
}
function markDirty() {
  // Ahead of the flag on purpose: the autosave this arms must never reach /save before the PATCH.
  if (state.status === 'pending_review') pullBackFromReview();
  _dirty = true; _autoState = 'idle'; armAutosave(); updateSaveChip();
}
```

- [ ] **Step 5: Clear the failure flag whenever a different quote is opened**

The flag is per-quote, not per-session. At `ops-ui.html:5327`, immediately after:

```js
  _openSeq++; // an in-flight reopen must not clobber the fresh draft
```

add:

```js
  _pullbackFailed = false; // per-quote: a failed pull-back must not lock the next one
```

And at `:6116`, inside `reopenQuote(id)` (the function that hydrates a fetched quote), immediately after:

```js
  var seq = ++_openSeq;
```

add the same line:

```js
  _pullbackFailed = false; // per-quote: a failed pull-back must not lock the next one
```

- [ ] **Step 6: Add the ordering guard to the two paths that reach /save**

At `ops-ui.html:5535-5537`, replace:

```js
async function saveQuote(opts) {
  opts = opts || {};
  if (!state.vehicleType) {
```

with:

```js
async function saveQuote(opts) {
  opts = opts || {};
  // Ordering guarantee (owner, 2026-08-22). An edit made while the quote was still in review must
  // not reach /save before the pull-back PATCH lands, or the server 409s not_editable and the
  // operator's typing is silently lost. This await is what makes it a guarantee, not a race the
  // 2.5s autosave debounce happens to win.
  if (_pullback) await _pullback;
  if (!isSavableNow()) return false; // pull-back failed; pullBackFromReview already said why
  if (!state.vehicleType) {
```

At `:4757`, replace:

```js
  if (!isEditableNow() || !state.vehicleType) return;
```

with:

```js
  if (_pullback) await _pullback; // the pull-back PATCH must land before any /save
  if (!isSavableNow() || !state.vehicleType) return;
```

- [ ] **Step 7: Point the transition flush gate at the savable set**

At `:5612`, replace:

```js
  var editable = isEditableNow(); // review lock: pending_review no longer flushes a save (it would 409)
```

with:

```js
  // Must read the SAVABLE set, not the editable one: pending_review is editable on screen, and
  // flushing a save there POSTs to /save, takes a 409 and aborts the transition — the bug commit
  // 3d93b56 fixed, which widening isEditableNow() would silently reintroduce. There is nothing to
  // flush anyway: any edit has already moved the quote to draft via the pull-back.
  var editable = isSavableNow();
```

- [ ] **Step 8: Update the banner and blockers copy**

At `:8357-8360`, replace:

```js
  if (s === 'pending_review') {
    return isApprover()
      ? banner('amber', 'In review — locked', 'Approve, send back, or reopen to edit.')
      : banner('amber', 'Submitted — locked', 'With the founder. Reopen to edit if you need to change it.');
  }
```

with:

```js
  if (s === 'pending_review') {
    // States the consequence BEFORE anything is touched — this banner is the whole warning the
    // pull-back gets, and it has to be readable before the first keystroke, not after it.
    return isApprover()
      ? banner('amber', 'In review', 'Approve, send back, or just start editing — editing pulls it back to draft.')
      : banner('amber', 'Submitted — with the founder', 'Start editing and it comes back to you as a draft to resubmit.');
  }
```

At `:8312-8317`, replace:

```js
    /* A quote already in review is content-LOCKED (isEditableNow), so every field the rows point
       at is disabled — which reads as a dead list unless we name the one door back in. Reachable
       for a quote submitted before this gate existed, or one whose price later fell out. */
    (isEditableNow() ? '' :
      '  <p class="ch-blockers-sub ch-blockers-locked">This quote is locked while in review — '
      + '<b>Reopen to edit</b> to fix these, then resubmit.</p>'),
```

with:

```js
    /* A content-LOCKED quote has every field these rows point at disabled — which reads as a dead
       list unless we name the door back in. Since 2026-08-22 this no longer covers pending_review
       (that edits in place), so it must not say "while in review" any more. */
    (isEditableNow() ? '' :
      '  <p class="ch-blockers-sub ch-blockers-locked">This quote is locked — '
      + '<b>Reopen to edit</b> to fix these, then resubmit.</p>'),
```

- [ ] **Step 9: Run the source-scan tests to verify they pass**

```bash
cd api && npx vitest run src/routes/opsUi.test.ts
```

Expected: PASS, whole file — not just the new describe. If another block fails, it is asserting the old lock; read it before changing it and report rather than loosening an unrelated assertion.

- [ ] **Step 10: Repair the two e2e specs that assert the old lock**

In `web-tests/e2e/quote-approval.spec.js`, in the test `'founder on a pending_review quote gets Approve + Send back + the reopen door'` at `:283`, replace these four lines:

```js
  await expect(actions(page).locator('[data-action="reopenToDraft"]')).toBeVisible();
  await expect(page.locator('.ch-review-banner')).toContainText(/locked/i);
  await expect(page.locator('#quoteRoot .ch-app')).toHaveClass(/ch-locked/);
  await expect(page.locator('#f-firstName')).toBeDisabled();
```

with:

```js
  await expect(actions(page).locator('[data-action="reopenToDraft"]')).toBeVisible();
  // Owner, 2026-08-22: review no longer freezes content. The banner warns that editing pulls the
  // quote back, and the editor is live — the guarantee is kept by the pull-back, not by a lock.
  await expect(page.locator('.ch-review-banner')).toContainText(/pulls it back to draft/i);
  await expect(page.locator('#quoteRoot .ch-app')).not.toHaveClass(/ch-locked/);
  await expect(page.locator('#f-firstName')).toBeEnabled();
```

Also update that test's two-line comment above those assertions from `// Review lock (owner, 2026-07-17): submission freezes content — the banner names the lock,` / `// the action bar offers the one door back in, and the editor renders inert.` to:

```js
  // The founder's review powers are unchanged; what changed (2026-08-22) is that the editor
  // underneath them is live, and touching it pulls the quote back out of review.
```

In `web-tests/e2e/ops-leg-card-layout.spec.js:59`, the `q_locked` fixture is `pending_review`, which is no longer locked. Change:

```js
    id: 'q_locked', reference: 'Q-LOCK', status: 'pending_review',
```

to:

```js
    // 'ready' rather than 'pending_review' since 2026-08-22: review no longer locks content, so
    // an in-review fixture would no longer be locked and this spec would stop testing anything.
    id: 'q_locked', reference: 'Q-LOCK', status: 'ready',
```

- [ ] **Step 11: Add the behavioural e2e for the pull-back**

Append to `web-tests/e2e/quote-approval.spec.js`, directly after the `'Reopen to edit on a ready quote PATCHes to draft (no spurious /save 409 abort)'` test:

```js
// Editing in review (owner, 2026-08-22). Ops does not have to find the reopen button first —
// typing is the gesture, and it takes the quote out of the founder's queue on the way.
test('ops typing on a pending_review quote pulls it back to draft, once', async ({ page }) => {
  const store = await openDetail(page, 'ops', { id: 'q1', status: 'pending_review' });
  await expect(page.locator('#quoteRoot .ch-app')).not.toHaveClass(/ch-locked/);
  await expect(page.locator('#f-firstName')).toBeEnabled();
  await page.fill('#f-firstName', 'Nimal');
  await expect(page.locator('.ch-status-pill')).toContainText('Draft', { timeout: 10000 });
  // Idempotent: a whole name typed in is still exactly one status PATCH, not one per keystroke.
  expect(store.patches.filter((p) => p.id === 'q1' && p.status === 'draft')).toHaveLength(1);
});
```

If `page.fill` does not trigger the app's input handler (it dispatches a single `input` event, which is what the delegated listener at `ops-ui.html:9295` expects), use `page.locator('#f-firstName').pressSequentially('Nimal')` instead — and keep the `toHaveLength(1)` assertion, which is the one that proves idempotence.

- [ ] **Step 12: Run the full web test suite**

```bash
cd web-tests && npm run test:all
```

Expected: PASS. `test:all` includes Playwright — vitest alone will report green while these e2e specs are broken.

- [ ] **Step 13: Run the API gate**

```bash
cd api && npm run check
```

Expected: PASS (typecheck + lint + test).

- [ ] **Step 14: Commit**

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.test.ts web-tests/e2e/quote-approval.spec.js web-tests/e2e/ops-leg-card-layout.spec.js
git commit -m "feat(ops): edit a quote in review — the first edit pulls it back to draft"
```

---

### Task 2: Ops can reopen an approved quote

**Files:**
- Modify: `api/src/routes/ops-ui.html:8166`
- Test: `web-tests/e2e/quote-approval.spec.js`, `api/src/routes/opsUi.test.ts`

**Interfaces:**
- Consumes: existing `reopenToDraft()` (`:5939`) and the `B(action, label, cls)` action-bar helper. Nothing new is produced.

Context: the server already accepts `ready → draft` from an ops session — only reopening a `sent` quote is founder-gated (`internalQuote.ts:1532`, `reopeningSent`). Today's restriction is the UI hiding a button that already works, so this task is one line plus its proof.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/e2e/quote-approval.spec.js`:

```js
// Owner, 2026-08-22: "as long as it's not sent to customer an ops person should be able to
// reopen." The server already allows ready → draft for ops (only `sent` is founder-gated), so
// this is the UI catching up with the rule, not a new permission.
test('ops on a ready quote gets the reopen door', async ({ page }) => {
  const store = await openDetail(page, 'ops', { id: 'q1', status: 'ready' });
  await actions(page).locator('[data-action="reopenToDraft"]').click();
  await expect(page.locator('.ch-status-pill')).toContainText('Draft', { timeout: 10000 });
  expect(store.patches.some((p) => p.id === 'q1' && p.status === 'draft')).toBe(true);
});

test('ops on a SENT quote still has no reopen door', async ({ page }) => {
  await openDetail(page, 'ops', { id: 'q1', status: 'sent' });
  await expect(actions(page).locator('[data-action="markWon"]')).toBeVisible(); // bar did render
  await expect(actions(page).locator('[data-action="reopenToDraft"]')).toHaveCount(0);
});
```

And add this `it` inside the `describe('ops UI — editing a quote in review', ...)` block in `api/src/routes/opsUi.test.ts`:

```ts
it('the ready row offers reopen to both roles, and the sent row only to the approver', () => {
  const bar = body.slice(body.indexOf('function renderActionBar('), body.indexOf('function renderReviewBanner('));
  const readyRows = bar.split('\n').filter(l => l.includes("s === 'ready'"));
  expect(readyRows.length).toBeGreaterThanOrEqual(2); // approver + non-approver rows
  readyRows.forEach(row => expect(row).toContain('reopenToDraft'));
  // The owner's line: a quote the customer already has stays founder-only.
  const sentRows = bar.split('\n').filter(l => l.includes("s === 'sent'"));
  expect(sentRows.filter(r => r.includes('reopenToDraft'))).toHaveLength(1); // approver row only
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && npx vitest run src/routes/opsUi.test.ts -t "the ready row offers reopen"
```

Expected: FAIL — `readyRows.forEach(...toContain('reopenToDraft'))` fails on the non-approver row.

```bash
cd web-tests && npx playwright test e2e/quote-approval.spec.js -g "ops on a ready quote gets the reopen door"
```

Expected: FAIL — the `[data-action="reopenToDraft"]` locator resolves to zero elements, so the click times out.

- [ ] **Step 3: Add the button to the non-approver ready row**

At `ops-ui.html:8166`, replace:

```js
    else if (s === 'ready') { out.push(B('markSent', 'Mark as sent to customer', 'ch-btn-primary'), QUOTELINK, PAYLINK); if (PAYPART) out.push(PAYPART); }
```

with:

```js
    /* Reopen on 'ready' for ops too (owner, 2026-08-22): anything the customer has not been sent
       is theirs to pull back. The server already accepted this — only `sent` is founder-gated —
       so hiding the button was cosmetic. Deliberately the BUTTON and not the type-and-pull-back
       of pending_review: reopening drops the frozen rate card and re-prices. One line on purpose,
       like the pending_review row: the action-bar tests scan this bar line-by-line. */
    else if (s === 'ready') { out.push(B('markSent', 'Mark as sent to customer', 'ch-btn-primary'), QUOTELINK, PAYLINK); if (PAYPART) out.push(PAYPART); out.push(B('reopenToDraft', 'Reopen to edit', 'ch-btn-ghost')); }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && npx vitest run src/routes/opsUi.test.ts
cd web-tests && npx playwright test e2e/quote-approval.spec.js
```

Expected: PASS, both files in full.

- [ ] **Step 5: Run both gates**

```bash
cd api && npm run check
```

```bash
cd web-tests && npm run test:all
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops-ui.html api/src/routes/opsUi.test.ts web-tests/e2e/quote-approval.spec.js
git commit -m "feat(ops): let ops reopen an approved quote, up to the moment it is sent"
```

---

## Done when

- An ops person opening a `pending_review` quote sees a live editor and a banner saying editing pulls it back; typing moves it to `draft` with one PATCH and one toast, and the edit saves.
- An ops person on a `ready` quote has a "Reopen to edit" button; on a `sent` quote they do not.
- `POST /internal/quotes/save` still returns 409 `not_editable` for `pending_review` — unchanged, and now load-bearing.
- `cd api && npm run check` and `cd web-tests && npm run test:all` both pass.

## Not in this plan

- Any server-side rule, schema, or migration change.
- Closing the "cosmetic lock" on `ready` server-side — the owner's decision makes that permissiveness correct, not a hole.
- The pay-link corner (a `ready` quote whose price is already with the customer via a minted link). Recorded in spec §6; the existing price-drift indicator is the mitigation.
