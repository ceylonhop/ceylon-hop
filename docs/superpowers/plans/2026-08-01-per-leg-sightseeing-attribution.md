# Per-leg Extras Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each per-leg extra (sightseeing / waiting / safari-wait) say which leg it belongs to, instead of producing N identical anonymous line items.

**Architecture:** Widen `QuoteRequest.extras` to accept `{ code, legIndex }` alongside the bare `ExtraCode` and normalize once at engine entry. `collectExtras` supplies the **driving** leg index; `priceExtras` resolves it to the leg's route name and emits it in the label plus `meta`. Back-compatible by construction: an extra with no `legIndex` behaves exactly as today, so the four non-ops producers and every golden are untouched.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest. Backend in `api/`.

**Spec:** `docs/superpowers/specs/2026-08-01-per-leg-sightseeing-attribution-design.md`

## Global Constraints

- **No price changes.** Every total must be identical before and after, in every task. $10 per ticked private leg, $0 on chauffeur. Do not edit `rateCard.ts`; do not run `npm run generate`.
- **No schema/migration changes.** Leg flags already persist as booleans.
- **`goldens.test.ts` must stay green without rebaselining.** A moved golden means the normalization is not behaviour-preserving — stop and report, do not update the golden.
- **Extras line items must be pushed after travel line items.** `ops-ui.html` splits `lineItems` into travel-vs-extras by "the first N are the driving legs".
- **Applies to all three toggles:** `addSightseeingFee`, `addWaitingFee`, `addSafariWait`.
- **Do not touch** `booking.html`, `booking.js`, `transfers-data.js`, `notifications.ts`, or `rateCard.ts`.
- **Gate before PR:** `cd api && npm run check` and, from the repo root, `npm run test:all`.
- Working branch: `worktree-sightseeing-leg-attribution`, in the worktree at `.claude/worktrees/sightseeing-leg-attribution/`. Never `git add -A` — stage by explicit path.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `api/src/quote/types.ts` | `ExtraInput` union, `NormalizedExtra`, `normalizeExtra()`; widen `QuoteRequest.extras` | Modify |
| `api/src/quote/extrasDeposit.ts` | `priceExtras` resolves `legIndex` → label + `meta` | Modify |
| `api/src/quote/engine.ts` | Private path passes leg names; chauffeur path stops emitting `(included)` rows | Modify |
| `api/src/routes/internalQuote.ts` | `collectExtras` emits the **driving** leg index | Modify |
| `api/src/routes/ops-ui.html` | Stale `"point-to-point only"` comment | Modify (comment only) |
| `api/src/quote/extrasDeposit.test.ts` | Attribution unit tests | Modify |
| `api/src/quote/engine.test.ts` | Chauffeur rows removed; ordering invariant | Modify |
| `api/src/routes/internalQuote.test.ts` | Driving-index + stay-day regression | Modify |

---

### Task 1: Attributed extras — type + pricing

**Files:**
- Modify: `api/src/quote/types.ts:20-25`, `api/src/quote/types.ts:64`
- Modify: `api/src/quote/extrasDeposit.ts:13-23`
- Test: `api/src/quote/extrasDeposit.test.ts`

**Interfaces:**
- Consumes: `ExtraCode` from `./rateCard`; `LineItem` from `./types`.
- Produces: `ExtraInput`, `NormalizedExtra`, `normalizeExtra(e: ExtraInput): NormalizedExtra` from `./types`. `priceExtras(extras: ExtraInput[], rateCard?: RateCard, legNames?: string[]): { lineItems: LineItem[]; subtotalCents: number }` — third parameter is new and optional.

- [ ] **Step 1: Write the failing tests**

Append to `api/src/quote/extrasDeposit.test.ts`:

```ts
describe('priceExtras attribution', () => {
  it('names the leg when legIndex resolves against legNames', () => {
    const r = priceExtras([{ code: 'sightseeing', legIndex: 1 }], undefined, ['Colombo → Kandy', 'Kandy → Ella']);
    expect(r.lineItems).toEqual([
      {
        label: 'Sightseeing stops (up to 3h) — Kandy → Ella',
        amountCents: 1000,
        meta: { kind: 'extra', code: 'sightseeing', legIndex: 1 },
      },
    ]);
    expect(r.subtotalCents).toBe(1000);
  });

  it('two attributed extras name DIFFERENT legs and still total 2x', () => {
    const r = priceExtras(
      [{ code: 'sightseeing', legIndex: 0 }, { code: 'sightseeing', legIndex: 2 }],
      undefined,
      ['Colombo → Kandy', 'Kandy → Ella', 'Ella → Yala'],
    );
    expect(r.lineItems.map((li) => li.label)).toEqual([
      'Sightseeing stops (up to 3h) — Colombo → Kandy',
      'Sightseeing stops (up to 3h) — Ella → Yala',
    ]);
    expect(r.subtotalCents).toBe(2000);
  });

  it('a bare ExtraCode is byte-identical to today — no meta, no leg name', () => {
    const r = priceExtras(['sightseeing']);
    expect(r.lineItems).toEqual([{ label: 'Sightseeing stops (up to 3h)', amountCents: 1000 }]);
  });

  it('legIndex with no resolvable name keeps the bare label but still records meta', () => {
    const r = priceExtras([{ code: 'waiting', legIndex: 7 }], undefined, ['Colombo → Kandy']);
    expect(r.lineItems[0].label).toBe('Waiting fee');
    expect(r.lineItems[0].meta).toEqual({ kind: 'extra', code: 'waiting', legIndex: 7 });
  });

  it('rejects an unknown code in the attributed shape too', () => {
    // @ts-expect-error - deliberately invalid code
    expect(() => priceExtras([{ code: 'bogus', legIndex: 0 }])).toThrow('UNKNOWN_EXTRA');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd api && npx vitest run src/quote/extrasDeposit.test.ts
```

Expected: FAIL. The attributed cases fail because `priceExtras` indexes `rateCard.extras` with an object, yielding `undefined` → `UNKNOWN_EXTRA`.

- [ ] **Step 3: Add the type and normalizer**

In `api/src/quote/types.ts`, immediately above the `QuoteRequest` definition (before the `// customPerKmCents (GL-1d)` comment block at line 14):

```ts
// An extra may arrive as a bare code (website / single-transfer paths, and every stored
// quote predating attribution) or attributed to the driving leg that carries it (ops tool).
// legIndex indexes the engine's DRIVING legs — the same list `quotePrivateLegs` prices —
// never the ops tool's raw `state.legs`, which includes stay days.
export type ExtraInput = ExtraCode | { code: ExtraCode; legIndex?: number };
export interface NormalizedExtra { code: ExtraCode; legIndex?: number }

export function normalizeExtra(e: ExtraInput): NormalizedExtra {
  return typeof e === 'string' ? { code: e } : { code: e.code, legIndex: e.legIndex };
}
```

Then widen both product variants — `api/src/quote/types.ts:22` and `:25` — changing `extras?: ExtraCode[]` to `extras?: ExtraInput[]` in each. Leave every other field untouched.

- [ ] **Step 4: Rewrite `priceExtras`**

Replace the body of `priceExtras` in `api/src/quote/extrasDeposit.ts`:

```ts
// legNames[i] is the display name of driving leg i (e.g. "Kandy → Ella"). When an extra
// carries a legIndex that resolves against it, the leg is named in the label so ops and the
// traveller can see WHICH day the charge belongs to. Unattributed extras are untouched —
// that is what keeps the website/singleTransfer paths and every golden byte-identical.
export function priceExtras(
  extras: ExtraInput[],
  rateCard: RateCard = RATE_CARD,
  legNames?: string[],
): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const raw of extras) {
    const { code, legIndex } = normalizeExtra(raw);
    const amountCents = (rateCard.extras as Record<string, number>)[code];
    if (amountCents === undefined) throw new Error('UNKNOWN_EXTRA');
    const legName = legIndex != null ? legNames?.[legIndex] : undefined;
    const label = legName ? `${EXTRA_LABELS[code]} — ${legName}` : EXTRA_LABELS[code];
    lineItems.push(
      legIndex != null
        ? { label, amountCents, meta: { kind: 'extra', code, legIndex } }
        : { label, amountCents },
    );
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents };
}
```

Update the imports at the top of `extrasDeposit.ts` — it currently imports `ExtraCode` from `./rateCard` and `LineItem` from `./types`. Add the two new names:

```ts
import { type ExtraInput, normalizeExtra } from './types';
```

`ExtraCode` stays imported from `./rateCard` for `EXTRA_LABELS`.

- [ ] **Step 5: Run to verify they pass, and that nothing else moved**

```bash
cd api && npx vitest run src/quote/extrasDeposit.test.ts src/quote/goldens.test.ts
```

Expected: PASS, goldens included. **If any golden fails, stop and report** — per Global Constraints, do not rebaseline.

- [ ] **Step 6: Commit**

```bash
git add api/src/quote/types.ts api/src/quote/extrasDeposit.ts api/src/quote/extrasDeposit.test.ts
git commit -m "feat(quote): extras can carry the driving leg they belong to"
```

---

### Task 2: Private path names the leg

**Files:**
- Modify: `api/src/quote/engine.ts:64-68`
- Test: `api/src/quote/engine.test.ts`

**Interfaces:**
- Consumes: `priceExtras(extras, rateCard, legNames?)` from Task 1.
- Produces: private quotes whose attributed extras carry `meta.kind === 'extra'` and a leg-named label.

Context: inside the `product === 'private'` branch, `rides` is already in scope (`const rides = req.legs.map(normalizeRide)`), and `quotePrivateLegs` labels each travel item as `` `${ride.stops.join(' → ')} (${vehicle})` ``. Reuse the same `stops.join(' → ')` so the extra's leg name matches its travel row exactly.

- [ ] **Step 1: Write the failing test**

Append to `api/src/quote/engine.test.ts`:

```ts
describe('private extras attribution', () => {
  const threeLegs = {
    product: 'private' as const, vehicle: 'car' as const, pax: 2, bags: 2,
    legs: [
      { from: 'Colombo', to: 'Kandy', distanceKm: 120 },
      { from: 'Kandy', to: 'Ella', distanceKm: 140 },
      { from: 'Ella', to: 'Yala', distanceKm: 100 },
    ],
  };

  it('names the leg each extra belongs to', () => {
    const r = quote({ ...threeLegs, extras: [{ code: 'sightseeing', legIndex: 1 }] });
    const extra = r.lineItems.find((li) => li.meta && (li.meta as { kind?: string }).kind === 'extra');
    expect(extra?.label).toBe('Sightseeing stops (up to 3h) — Kandy → Ella');
    expect(extra?.amountCents).toBe(1000);
  });

  it('two ticked legs produce two DIFFERENTLY named rows', () => {
    const r = quote({
      ...threeLegs,
      extras: [{ code: 'sightseeing', legIndex: 0 }, { code: 'sightseeing', legIndex: 2 }],
    });
    const labels = r.lineItems
      .filter((li) => li.meta && (li.meta as { kind?: string }).kind === 'extra')
      .map((li) => li.label);
    expect(labels).toEqual([
      'Sightseeing stops (up to 3h) — Colombo → Kandy',
      'Sightseeing stops (up to 3h) — Ella → Yala',
    ]);
  });

  it('attribution does not change the total', () => {
    const bare = quote({ ...threeLegs, extras: ['sightseeing'] });
    const attributed = quote({ ...threeLegs, extras: [{ code: 'sightseeing', legIndex: 1 }] });
    expect(attributed.totalCents).toBe(bare.totalCents);
  });

  it('extras line items come AFTER every travel line item', () => {
    const r = quote({
      ...threeLegs,
      extras: [{ code: 'sightseeing', legIndex: 0 }, { code: 'waiting', legIndex: 1 }],
    });
    const firstExtra = r.lineItems.findIndex((li) => (li.meta as { kind?: string } | undefined)?.kind === 'extra');
    const lastTravel = r.lineItems.map((li) => 'billableKm' in ((li.meta ?? {}) as object)).lastIndexOf(true);
    expect(firstExtra).toBeGreaterThan(lastTravel);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd api && npx vitest run src/quote/engine.test.ts -t "private extras attribution"
```

Expected: FAIL — labels come back bare (`'Sightseeing stops (up to 3h)'`) and `meta` is absent, because the engine does not yet pass leg names.

- [ ] **Step 3: Pass the leg names**

In `api/src/quote/engine.ts`, replace the private-path extras block at lines 64-68:

```ts
    if (req.extras?.length) {
      // Name each attributed extra after the ride it belongs to, using the SAME
      // stops.join(' → ') that quotePrivateLegs uses for the travel row, so the two
      // rows read as a matched pair. Pushed after the travel items on purpose —
      // ops-ui splits lineItems by "the first N are the driving legs".
      const e = priceExtras(req.extras, rateCard, rides.map((r) => r.stops.join(' → ')));
      lineItems.push(...e.lineItems);
      subtotalCents += e.subtotalCents;
    }
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd api && npx vitest run src/quote/engine.test.ts src/quote/goldens.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/engine.ts api/src/quote/engine.test.ts
git commit -m "feat(quote): private extras name the leg they belong to"
```

---

### Task 3: Chauffeur emits no extras rows

**Files:**
- Modify: `api/src/quote/engine.ts:93-107`, and the import on `api/src/quote/engine.ts:9`
- Test: `api/src/quote/engine.test.ts:86`, `:112`

**Interfaces:**
- Consumes: `normalizeExtra` from `./types`, `CHAUFFEUR_INCLUDED_EXTRAS` from `./rateCard` (both already available).
- Produces: chauffeur quotes with **zero** line items for included extras; warnings unchanged.

Owner decision D2: show nothing at all. D4: keep the warnings — they are ops-facing and are the only trace that a flag arrived and was ignored.

- [ ] **Step 1: Update the two existing tests that assert the removed rows**

In `api/src/quote/engine.test.ts`, the test at line 86 (`'chauffeur: sightseeing + waiting are included in day rate → total unchanged, warnings note both'`) and the one at line 112 (`'chauffeur: sightseeing + luggage → only luggage added, sightseeing warned as included'`) assert the `(included)` line items. Change those assertions to require the rows are **absent**, keeping every total and warning assertion exactly as it is. Add to each:

```ts
    expect(withExtras.lineItems.some((li) => li.label.includes('(included)'))).toBe(false);
```

Then append a new test:

```ts
it('chauffeur: an attributed sightseeing flag produces NO line item and no charge', () => {
  const base = {
    product: 'chauffeur' as const, vehicle: 'car' as const,
    firstDate: '2026-02-10', lastDate: '2026-02-12',
    travelDays: [
      { date: '2026-02-10', from: 'Colombo', to: 'Kandy', distanceKm: 120 },
      { date: '2026-02-12', from: 'Kandy', to: 'Ella', distanceKm: 140 },
    ],
  };
  const withFlag = quote({ ...base, extras: [{ code: 'sightseeing', legIndex: 1 }] });
  expect(withFlag.totalCents).toBe(quote(base).totalCents);
  expect(withFlag.lineItems.some((li) => /Sightseeing/.test(li.label))).toBe(false);
  expect(withFlag.warnings.some((w) => w.includes('sightseeing included in chauffeur day rate'))).toBe(true);
});
```

- [ ] **Step 2: Run to verify the new expectations fail**

```bash
cd api && npx vitest run src/quote/engine.test.ts -t "chauffeur"
```

Expected: FAIL — the `(included)` rows are still emitted, and the attributed flag throws or produces a row.

- [ ] **Step 3: Remove the included line items**

In `api/src/quote/engine.ts`, replace the chauffeur extras block at lines 93-107:

```ts
    if (req.extras?.length) {
      // Chauffeur trips include the vehicle all day: sightseeing/waiting/safari-wait are
      // already covered by the day rate and must never be charged again. Owner call
      // (2026-08-01): they are not printed either — a $0 row is noise on a quote where the
      // car is the traveller's all day. The warning stays: it is the only trace that a flag
      // arrived and was deliberately ignored, and the toggle is hidden under chauffeur.
      const normalized = req.extras.map(normalizeExtra);
      const included = normalized.filter((x) => (CHAUFFEUR_INCLUDED_EXTRAS as readonly string[]).includes(x.code));
      const chargeable = normalized.filter((x) => !(CHAUFFEUR_INCLUDED_EXTRAS as readonly string[]).includes(x.code));
      for (const x of included) {
        warnings.push(`${x.code} included in chauffeur day rate`);
      }
      if (chargeable.length) {
        // No legNames here on purpose: the three attributable extras are all included-and-
        // dropped above, so anything still chargeable is a trip-level extra (luggage rack,
        // child seat, flexi) arriving unattributed from the website path.
        const e = priceExtras(chargeable, rateCard);
        lineItems.push(...e.lineItems);
        subtotalCents += e.subtotalCents;
      }
    }
```

Add `normalizeExtra` to the type import on line 4:

```ts
import { normalizeRide, normalizeChauffeurDay, rideRawKm, validateRide, normalizeExtra } from './types';
```

`EXTRA_LABELS` is now unused in `engine.ts` — remove it from the line 9 import, leaving:

```ts
import { priceExtras, depositCents } from './extrasDeposit';
```

- [ ] **Step 4: Run to verify they pass**

```bash
cd api && npx vitest run src/quote/engine.test.ts src/quote/goldens.test.ts
```

Expected: PASS. If lint flags an unused import, that is Step 3's `EXTRA_LABELS` removal not being applied.

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/engine.ts api/src/quote/engine.test.ts
git commit -m "feat(quote): chauffeur no longer prints \$0 (included) extras rows"
```

---

### Task 4: `collectExtras` supplies the driving index

**Files:**
- Modify: `api/src/routes/internalQuote.ts:244-252`
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `ExtraInput` from `../quote/types`; `drives(l: ToolLeg): boolean` already defined at `internalQuote.ts:224`.
- Produces: `collectExtras(legs: ToolLeg[]): ExtraInput[]`.

**This is the task most likely to go quietly wrong.** `toEngineRequest` builds `driving = req.legs.filter(drives)` and hands only those to the engine, but `collectExtras` is called with **all** legs. So the natural `forEach` index is the raw `state.legs` index, and on any trip containing a stay day it drifts from the engine's leg list — every attribution after the stay day would name the wrong leg, with a correct-looking total.

Note the running-counter shape below: legs that do not drive still contribute their extras (unattributed), which is what today's code does. **Do not "clean this up" by filtering to driving legs first** — that would silently stop charging a flag on a stay day and change a total, violating the no-price-change constraint.

- [ ] **Step 1: Write the failing tests**

Append to `api/src/routes/internalQuote.test.ts`:

```ts
describe('per-leg extras attribution', () => {
  it('attributes each extra to its own leg', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2,
      legs: [
        { category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, addSightseeingFee: true },
      ],
    });
    const body = await res.json();
    expect(body.lineItems.some((li: { label: string }) =>
      li.label === 'Sightseeing stops (up to 3h) — Kandy → Ella')).toBe(true);
  });

  it('REGRESSION: a stay day between two legs does not shift attribution', async () => {
    // The stay day is dropped before pricing, so a raw state.legs index would name
    // "Kandy → Ella" for a charge that actually belongs to "Ella → Yala".
    const res = await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2,
      legs: [
        { category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 },
        { category: 'stay_day', from: 'Kandy', to: 'Kandy', distanceKm: 0 },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { category: 'transfer', from: 'Ella', to: 'Yala', distanceKm: 100, addSightseeingFee: true },
      ],
    });
    const body = await res.json();
    const labels = body.lineItems.map((li: { label: string }) => li.label);
    expect(labels).toContain('Sightseeing stops (up to 3h) — Ella → Yala');
    expect(labels).not.toContain('Sightseeing stops (up to 3h) — Kandy → Ella');
  });

  it('totals are unchanged by attribution', async () => {
    const legs = [
      { category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 },
      { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, addSightseeingFee: true, addWaitingFee: true },
    ];
    const withFees = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs,
    })).json();
    const without = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2,
      legs: legs.map((l) => ({ ...l, addSightseeingFee: false, addWaitingFee: false })),
    })).json();
    expect(withFees.total.cents).toBe(without.total.cents + 1000 + 1000);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts -t "per-leg extras attribution"
```

Expected: FAIL — labels come back as the bare `'Sightseeing stops (up to 3h)'`.

- [ ] **Step 3: Emit the driving index**

Replace `collectExtras` at `api/src/routes/internalQuote.ts:244-252`:

```ts
// legIndex must be the DRIVING index — toEngineRequest hands the engine
// `req.legs.filter(drives)`, so a raw state.legs index drifts by one for every stay day
// before it and would name the wrong leg. Non-driving legs still contribute their extras,
// unattributed, exactly as before: dropping them would change a total.
function collectExtras(legs: ToolLeg[]): ExtraInput[] {
  const out: ExtraInput[] = [];
  let drivingIndex = -1;
  for (const l of legs) {
    const legIndex = drives(l) ? ++drivingIndex : undefined;
    if (l.addSightseeingFee) out.push({ code: 'sightseeing', legIndex });
    if (l.addWaitingFee) out.push({ code: 'waiting', legIndex });
    if (l.addSafariWait) out.push({ code: 'safari-wait', legIndex });
  }
  return out;
}
```

Update the type import in `internalQuote.ts` — replace the `ExtraCode` import used by `collectExtras`'s old return type with `ExtraInput` from `../quote/types`. If `ExtraCode` is still referenced elsewhere in the file, keep both.

- [ ] **Step 4: Run to verify they pass**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts
```

Expected: PASS, including the pre-existing extras tests at `:128`, `:425` and `:595`.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(ops): attribute per-leg extras to their driving leg"
```

---

### Task 5: Comment fix and full gate

**Files:**
- Modify: `api/src/routes/ops-ui.html:4271`
- Verify: `api/src/services/notifications.ts` (expected untouched)

- [ ] **Step 1: Correct the stale comment**

At `api/src/routes/ops-ui.html:4271` the comment reads `"+ Fees" (point-to-point only) opens the add-ons tray`. That predates multi-stop rides and contradicts the rule that a stop may just be a pickup. Replace that clause with:

```
  // "+ Fees" (any non-chauffeur, non-stay leg — multi-stop included, since a stop may be a
  // pickup rather than sightseeing) opens the add-ons tray — a solid orange pill names
```

Keep the surrounding sentences intact. Comment only — no behaviour change.

- [ ] **Step 2: Confirm the email path was not disturbed**

```bash
cd api && git diff --stat -- src/services/notifications.ts
```

Expected: empty output. Booking emails carry their own label map fed by booking extras, not quote line items. If this file shows a diff, something is out of scope — stop and report.

- [ ] **Step 3: Run the full backend gate**

```bash
cd api && npm run check
```

Expected: typecheck + lint + all tests pass. Baseline before this work was 1527 passed / 0 failures; the count will be higher, and failures must be zero.

- [ ] **Step 4: Run the web test suite**

```bash
npm run test:all
```

Run from the repo root. Expected: pass. `web-tests/e2e/quote-tool.spec.js` asserts the add-on checkboxes are attached and hidden under chauffeur; neither changes here. If a spec pins an extras label string, update it to the leg-named form — that is an intended change, not a regression.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html
git commit -m "docs(ops): fix stale point-to-point-only comment on the Fees chip"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin worktree-sightseeing-leg-attribution
gh pr create --base main --title "Per-leg extras name the leg they belong to" --body "$(cat <<'EOF'
Sightseeing/waiting/safari-wait already charge per ticked leg. They just did not say WHICH leg — N ticked legs produced N identical anonymous rows.

`QuoteRequest.extras` now accepts `{ code, legIndex }` alongside the bare code. `collectExtras` supplies the driving leg index; `priceExtras` names the leg in the label and records `meta.kind='extra'`. Unattributed extras are untouched, so the website/singleTransfer paths and every golden are byte-identical.

Chauffeur no longer prints `$0 (included)` rows (owner call) — the warnings stay.

No price, schema, or website change. Spec: `docs/superpowers/specs/2026-08-01-per-leg-sightseeing-attribution-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the implementer

- **Do not rebaseline a golden.** Goldens passing unattributed extras must not move. If one does, the normalization is not behaviour-preserving — stop and report.
- **Merging to `main` deploys to staging.** Production is a separate promote PR and is not part of this work.
- **Stage by explicit path.** Several sessions share the primary checkout; this work is isolated in a worktree, but the habit matters.
