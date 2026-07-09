# Quote Approval Workflow + Merged Quotes Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Support agents *submit* quotes into a review queue; the founder *reviews, edits in place, and approves* (or sends back); support then *copies the customer message and sends* — copy stays locked until approval. The two quoting nav items ("Generate Quote" + "Quotes") merge into **one queue-first surface**.

**Architecture:** Statuses gain a review lifecycle (plain `text` column — no DB migration). A founder-only `quote:approve` capability gates the approve transition server-side; the customer message is locked client-side until `ready`. The ops SPA drops the separate "Generate Quote" nav: **Quotes** becomes a role-aware queue (the front door) with the builder as the detail view of one quote. Review = editing the quote in place; **approve persists the current edits AND sets `ready` atomically.**

**Tech Stack:** Node 20 · TS (strict) · Hono · Vitest (api) · Playwright (web-tests) · ops SPA `api/src/routes/ops-ui.html`.

## Global Constraints
- Money = integer minor units; no new external services (CLAUDE.md).
- Quote `status` is `text('status')` (schema.ts:193) constrained by `QUOTE_STATUSES` in `api/src/db/quoteRepo.ts` — **adding statuses needs NO migration.**
- Caps: `api/src/lib/opsAuth.ts` (`CAPS` per role, `can(role, cap)`); routes gated by `requireCap(...)`; `/admin/quote/*` requires `quote:manage`.
- Margin is server-stripped for non-`margin:view` roles via `stripQuoteMargin` (internalQuote.ts) — do not weaken.
- `cd api && npm run check` + `cd web-tests && npm run test:all` green before each push. `quote-tool.spec.js` is `CH_E2E_API`-gated (needs a DB); use offline standalone ops specs for UI logic.

## Decisions (locked)
- **D1 Founder is the only approver.** `founder` gets `quote:approve`; finance/ops build+submit+send, don't approve.
- **D2 Send-back path included** (`pending_review → changes_requested`, with a note).
- **D3 "Sent" is a manual click** after copying (never auto-flip).
- **D4 v1 is queue-only** (no push notifications).
- **D5 Review = edit-in-place.** The founder opens a submitted quote into the full editable builder (margin visible) and can change anything. **Approve = save current edits + set `ready` in one action.** A plain **Save** persists mid-review without approving.
- **D6 Full merge.** Nav goes `Bookings · Quotes` (no "Generate Quote"). Quotes = role-aware queue home; the builder is the detail view (open a row, or "+ New quote").
- **D7 Founder self-approve.** An approver's own build goes `draft → ready` in one click ("Ready to send"); support goes through the full loop.

## Status model & transitions
Statuses (new **bold**): `draft` → **`pending_review`** → **`ready`** → `sent` → `won`/`lost`/`expired`; plus **`changes_requested`**. Self-approve adds `draft → ready` (capability-gated).

| From | To | Action | Who (server-enforced) |
|---|---|---|---|
| draft / changes_requested | pending_review | Submit for review | quote:manage |
| draft / changes_requested | ready | Ready to send (self-approve) | **quote:approve** |
| pending_review | ready | Ready to send | **quote:approve** |
| pending_review | changes_requested | Send back (+note) | **quote:approve** |
| ready | sent | Mark sent | quote:manage |
| ready / pending_review | draft | Reopen to edit | quote:manage |
| live state | won/lost/expired | outcome (existing) | quote:manage |

`canTransition` encodes structural legality; the `→ ready`/`→ changes_requested` **capability** check is separate (Task 3) — so `draft → ready` is legal but a non-approver gets `403`.

Customer output (WhatsApp/Email tabs + Copy) renders only when status ∈ {`ready`,`sent`}; else a locked card. Internal breakdown always available.

## File map
- `api/src/db/quoteRepo.ts` — statuses + `canTransition`.
- `api/src/lib/opsAuth.ts` — `quote:approve` (founder).
- `api/src/routes/internalQuote.ts` — PATCH transition + approve guard.
- `api/src/routes/ops-ui.html` — merged Quotes surface (nav, queue sections, detail action bar, copy gate, review banner, save+approve).
- Tests: `api/src/db/quoteRepo.test.ts`, `api/src/routes/internalQuote.test.ts`, new `web-tests/e2e/quote-approval.spec.js`.

---

### Task 1: Statuses + `canTransition` (incl. self-approve draft→ready)
**Files:** Modify `api/src/db/quoteRepo.ts:3-5` + add `canTransition`; Test `api/src/db/quoteRepo.test.ts`.
**Produces:** enum with `pending_review`/`changes_requested`/`ready`; `canTransition(from,to): boolean`.

- [ ] **Step 1 — failing test:**
```ts
import { canTransition } from './quoteRepo';
it('maker-checker + self-approve legality', () => {
  expect(canTransition('draft','pending_review')).toBe(true);
  expect(canTransition('draft','ready')).toBe(true);           // self-approve (cap-gated in Task 3)
  expect(canTransition('pending_review','ready')).toBe(true);
  expect(canTransition('pending_review','changes_requested')).toBe(true);
  expect(canTransition('changes_requested','pending_review')).toBe(true);
  expect(canTransition('ready','sent')).toBe(true);
  expect(canTransition('ready','draft')).toBe(true);
  expect(canTransition('draft','sent')).toBe(false);
  expect(canTransition('pending_review','sent')).toBe(false);
  expect(canTransition('sent','lost')).toBe(true);
});
```
- [ ] **Step 2 — run FAIL:** `cd api && npx vitest run src/db/quoteRepo -t legality`
- [ ] **Step 3 — implement:**
```ts
export type QuoteStatus = 'draft'|'pending_review'|'changes_requested'|'ready'|'sent'|'won'|'lost'|'expired';
export const QUOTE_STATUSES: readonly QuoteStatus[] = ['draft','pending_review','changes_requested','ready','sent','won','lost','expired'];
const OUTCOMES: readonly QuoteStatus[] = ['won','lost','expired'];
const ALLOWED: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft:             ['pending_review','ready'],
  changes_requested: ['pending_review','ready','draft'],
  pending_review:    ['ready','changes_requested','draft'],
  ready:             ['sent','draft'],
  sent: [], won: [], lost: [], expired: [],
};
export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  if (OUTCOMES.includes(to) && from !== 'draft') return true;
  return ALLOWED[from].includes(to);
}
```
Keep existing `save()` default `'draft'` and `patch()` sent/decided stamping unchanged.
- [ ] **Step 4 — run PASS** + `npx vitest run src/db/quoteRepo` (existing green).
- [ ] **Step 5 — commit:** `feat(quote): review statuses + canTransition (with self-approve)`

---

### Task 2: Founder-only `quote:approve` cap
**Files:** Modify `api/src/lib/opsAuth.ts:5,10`; Test `api/src/lib/opsAuth.test.ts`.
- [ ] **Step 1 — failing test:** add table rows `['founder','quote:approve',true]`, `['finance','quote:approve',false]`, `['ops','quote:approve',false]`.
- [ ] **Step 2 — run FAIL:** `cd api && npx vitest run src/lib/opsAuth`
- [ ] **Step 3 — implement:** add `'quote:approve'` to the `Cap` union and to the `founder` set only.
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(rbac): founder-only quote:approve`

---

### Task 3: PATCH enforces transition + approve capability
**Files:** Modify `api/src/routes/internalQuote.ts:415-429`; Test `api/src/routes/internalQuote.test.ts`.
**Consumes:** `canTransition` (T1), `can(role,'quote:approve')` (T2).
**Produces:** `409 illegal_transition`; `403 approve_forbidden` when a non-approver targets `ready`/`changes_requested` (incl. self-approve `draft→ready`).

- [ ] **Step 1 — failing tests** (role harness already in file):
```ts
it('ops submits but cannot approve or self-approve', async () => {
  const { app } = appAs('ops'); const id = (await savedDraft(app)).id;
  expect((await patch(app, id, { status:'pending_review' })).status).toBe(200);
  expect((await patch(app, id, { status:'ready' })).status).toBe(403); // from pending_review, no cap
  const id2 = (await savedDraft(app)).id;
  expect((await patch(app, id2, { status:'ready' })).status).toBe(403); // self-approve blocked
});
it('founder approves and self-approves', async () => {
  const { app } = appAs('founder');
  const a = (await savedDraft(app)).id; await patch(app, a, { status:'pending_review' });
  expect((await patch(app, a, { status:'ready' })).status).toBe(200);
  const b = (await savedDraft(app)).id;
  expect((await patch(app, b, { status:'ready' })).status).toBe(200); // self-approve draft→ready
});
it('rejects illegal draft→sent', async () => {
  const { app } = appAs('ops'); const id = (await savedDraft(app)).id;
  const r = await patch(app, id, { status:'sent' });
  expect(r.status).toBe(409);
});
```
- [ ] **Step 2 — run FAIL:** `cd api && npx vitest run src/routes/internalQuote -t approve`
- [ ] **Step 3 — implement** (in PATCH `/:id`, after `bad_status`, before `deps.quotes.patch`):
```ts
if (body.status) {
  const current = await deps.quotes.get(c.req.param('id'));
  if (!current) return c.json({ error: 'not_found' }, 404);
  const to = body.status as QuoteStatus;
  if (!canTransition(current.status, to)) return c.json({ error: 'illegal_transition' }, 409);
  if ((to === 'ready' || to === 'changes_requested') && !can(c.get('identity').role, 'quote:approve')) {
    return c.json({ error: 'approve_forbidden' }, 403);
  }
}
```
Import `canTransition` from `../db/quoteRepo`. Leave the margin strip in the response untouched. (Approve-with-edits is one PATCH carrying `status:'ready'` plus the updated quote fields — the client sends the current builder state; if the save path is a separate endpoint, Task 7 sequences save-then-PATCH; confirm whether `/save` upserts by id or the PATCH body can carry fields, and note it here for the implementer.)
- [ ] **Step 4 — run PASS** + full `cd api && npm run check`.
- [ ] **Step 5 — commit:** `feat(quote): enforce transitions + founder approval on PATCH`

---

### Task 4: Confirm `quote:approve` reaches the client
**Files:** verify `api/src/routes/*` whoami/login caps derive from `CAPS[role]`.
- [ ] **Step 1:** `cd api && grep -rn "caps" src/routes src/lib/opsMiddleware.ts | grep -iE "CAPS\[|Array.from|caps:"`.
- [ ] **Step 2:** If caps come from `CAPS[role]` → no change; add an assertion that founder `whoami` includes `quote:approve`. If hardcoded → add it + test.
- [ ] **Step 3 — commit** (only if changed): `feat(quote): surface quote:approve to client`

---

### Task 5: Merge the nav — single "Quotes" surface
**Files:** Modify `api/src/routes/ops-ui.html` — nav renderer (~980), routing (`state.route`, ~1218-1275), the quote-view mount (`showQuoteView`, ~1189).
**Produces:** nav = `Bookings · Quotes`; `#quote` route lands on the **queue** (not a blank builder); a **"+ New quote"** control opens the builder detail; the old `Generate Quote` nav item is gone; deep-link `#quote` still works.
- [ ] **Step 1:** Remove the `Generate Quote` nav button; keep one `Quotes` nav (gated on `quote:manage`). Route `#quote`/`#quotes` → the queue view.
- [ ] **Step 2:** Add a `+ New quote` button in the queue header that opens the builder detail (reuse the existing fresh-quote init). "Open a row" → `reopenQuote(id)` into the detail.
- [ ] **Step 3:** Verify via Task 9 e2e (`-g "nav"`): no `Generate Quote` nav; `Quotes` lands on the queue; `+ New quote` opens the builder.
- [ ] **Step 4 — commit:** `feat(ops-ui): merge quoting into one queue-first Quotes surface`

---

### Task 6: Role-aware queue sections
**Files:** Modify `api/src/routes/ops-ui.html` — queue list renderer (~3025) + status filter (~1282).
**Produces:** the queue groups quotes by "what needs you", ordered by role: founder → **Needs your review** [pending_review] first, then Ready, Drafts, Sent, Outcomes; support → **Ready to send** [ready] + **Sent back to you** [changes_requested] first, then Your drafts, Awaiting review [pending_review], Sent. Each row shows status pill + customer + total (+ margin only if `margin:view`).
- [ ] **Step 1:** Build `queueSections(quotes, caps)` returning ordered `{title, status, rows}` groups per the role rule above (approver vs not).
- [ ] **Step 2:** Render sections (replace the single filter-chip list; keep an "All" expander for the full history).
- [ ] **Step 3:** Task 9 e2e (`-g "queue"`) — founder sees Needs-review first; support sees Ready-to-send first.
- [ ] **Step 4 — commit:** `feat(ops-ui): role-aware queue sections`

---

### Task 7: Detail view — review banner + action bar + save/approve
**Files:** Modify `api/src/routes/ops-ui.html` — editor header/action area (near status select ~1108) + delegated click switch (~3487).
**Produces:** in the builder detail: a **status pill** + (when `pending_review`) a **review banner** ("Submitted by [name] · [time]"); a role/status **action bar** — support: `Submit for review`; approver on draft/changes_requested: `Ready to send` (self-approve) ; approver on pending_review: `Ready to send · Send back`; support on ready: `Mark sent`; plus a persistent **Save**. `approveQuote` = **save current builder state then PATCH `status:'ready'`** (atomic from the operator's view: one click); `sendBackQuote` prompts a note → PATCH `changes_requested`. `409/403` → toast.
- [ ] **Step 1:** `renderQuoteActionBar(status, caps)` returns the correct buttons (data-actions: `submitQuote`, `approveQuote`, `sendBackQuote`, `markSent`, `saveQuote`).
- [ ] **Step 2:** Wire the delegated actions: `approveQuote` calls the existing save, awaits it, then the status PATCH to `ready`, then re-render; `submitQuote`→pending_review; `markSent`→sent; `sendBackQuote`→prompt+changes_requested. Add the review banner from the loaded quote's `submittedBy`/`submittedAt` (persist these on the `pending_review` transition — extend the PATCH/save to stamp them, or store in `notes`; decide in Step 2 and note it).
- [ ] **Step 3:** Task 9 e2e (`-g "action bar"`).
- [ ] **Step 4 — commit:** `feat(ops-ui): review banner + submit/approve/send-back/mark-sent + save-then-approve`

---

### Task 8: Copy gate (lock customer message until `ready`)
**Files:** Modify `api/src/routes/ops-ui.html` — output panel (Copy ~3220, `copyOutputText` ~2951).
**Produces:** WhatsApp/Email tabs + Copy render only when status ∈ {`ready`,`sent`}; else a locked card ("Awaiting founder review — the customer message unlocks once it's marked ready to send"). Internal tab always available.
- [ ] **Step 1:** Gate the output renderer on status.
- [ ] **Step 2:** Task 9 e2e (`-g "copy gate"`): pending_review → no WhatsApp tab/Copy, locked text present; ready → Copy present.
- [ ] **Step 3 — commit:** `feat(ops-ui): lock customer message until approved`

---

### Task 9: End-to-end role journeys (offline ops harness)
**Files:** Create `web-tests/e2e/quote-approval.spec.js` (stub `/admin/quote/*` + `whoami` caps, no DB; pattern from `ops-vehicle-chips.spec.js`).
- [ ] **Step 1 — nav/merge:** no `Generate Quote` nav; `Quotes` lands on the queue; `+ New quote` opens the builder.
- [ ] **Step 2 — support journey:** caps `['quote:manage']`; draft quote → `Submit for review` shown, **no margin**, **Copy locked**; stub status `ready` → Copy unlocks, `Mark sent` shown, no Approve.
- [ ] **Step 3 — founder journey:** caps include `quote:approve`+`margin:view`; pending_review quote → **margin visible**, review banner, `Ready to send`+`Send back`; fresh draft → `Ready to send` (self-approve, one click).
- [ ] **Step 4 — queue sections:** founder's queue leads with Needs-review; support's with Ready-to-send.
- [ ] **Step 5 — run:** `cd web-tests && npx playwright test quote-approval` — green.
- [ ] **Step 6 — commit:** `test(e2e): quote approval role journeys + merged surface`

---

### Task 10: Reconcile DB-gated spec + full verify + rollout
**Files:** Modify `web-tests/e2e/quote-tool.spec.js` (CH_E2E_API-gated).
- [ ] **Step 1:** Update its flows to the new lifecycle (helpers `submitQuote`/`approveAsFounder`) + nav merge; note blind update (not runnable locally).
- [ ] **Step 2:** `cd api && npm run check` + `cd web-tests && npm run test:all` green.
- [ ] **Step 3:** Before/after screenshots (support locked · founder review/approve · unlocked · queue sections) via a scratch standalone spec; review; delete it.
- [ ] **Step 4 — commit + push;** poll `/ops` for a marker; hard-refresh; walk both roles live.

---

## Self-review
- **Coverage:** submit (T1/T3/T7) · founder-only approve incl. self-approve (T1/T2/T3/T7) · edit-in-place + save-then-approve D5 (T7) · send-back D2 (T1/T3/T7) · manual mark-sent D3 (T1/T7) · copy gate (T8) · full merge D6 (T5) · role queue (T6) · margin hidden from support (existing; asserted T9). Notifications D4 out of scope.
- **No migration:** `status` is `text` (schema.ts:193); new values only in `QUOTE_STATUSES`.
- **Open impl detail flagged, not hand-waved:** whether `/save` upserts by id vs PATCH carries fields (T3/T7 Step 2) and where `submittedBy/at` persist (T7 Step 2) — resolved during those tasks by reading the save path, not guessed here.
- **Risk:** `quote-tool.spec.js` updates are blind (DB-gated). Copy gate is UX; the real control is server-enforced `quote:approve` on `→ ready` (T3).
