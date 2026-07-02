# Quote Tool UI Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the internal quoting tool to be the owner's designed "Ops · Quote Generator" (the qgen design), driven by the server engine for pricing and the lifecycle endpoints for save/list/status.

**Architecture:** Backend adds a small `quoteBreakdown` helper (km strip + per-leg prices from the engine's own primitives) and a read-only rate-card view; `/estimate` returns them. The tool's request mapping is extended to the design's leg model (categories, driver/car stays ⇒ chauffeur, fee toggles ⇒ engine extras, vehicle-tier gating). The front-end `quote-tool.html` is replaced wholesale by a vanilla-JS 1:1 port of the design (its CSS, header, six cards, timeline), wired to `/places`, `/distance`, `/estimate`, `/rate-card`, `/save`, `/list`, `/patch`. No core-engine change; no schema change.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Vitest · Playwright · vanilla JS/CSS (no React/Babel runtime).

## Global Constraints

- The design contract is `docs/qgen-design-extraction.md` — its CSS (§1), data model (§2), component layouts (§3), flags (§4), and output templates (§5) are reproduced **verbatim** except where a decision below overrides.
- Engine is the price authority. Never compute money in the browser. All money from `POST /estimate`; the design's `CH.compute`/`estimateRoute`/`legPrice` are NOT ported.
- Rate card is locked: `RATE_CARD.version === '2026-06-28'`, `perKmCents {car:46, van:83}`, `floorCents {car:2900, van:5000}`, `chauffeur.dayRateCents 3500`, `bufferPct 10`, `fxUsdToLkr 320`. Use these constants; never hardcode.
- `billableKm(rawKm)=Math.round(rawKm*1.1)`; per-leg price `legPriceCents(billableKm(km), vehicle)`. Both are exported from `api/src/quote/private.ts`.
- Service is DERIVED, not selected: any leg with `category==='stay_day'` OR `hasDriver` OR `hasCarStay` ⇒ chauffeur; else private. No "Service" control.
- Vehicles: `car→car`, `van_6→van` price; `van_9`/`van_14`/`custom` are pricing-gated (400 server-side, disabled client-side) until rates exist.
- Statuses = backend set `draft/sent/won/lost/expired`, shown as labels Draft / Sent / Booked (won) / Lost / Expired.
- Money = integer minor units (USD cents) + ISO currency. Backend in `api/` only; the tool HTML `api/src/routes/quote-tool.html` is editable. Do NOT edit the frozen root front-end.
- TDD: write test → RED → implement → GREEN → commit. `cd api && npm run check` must pass before each commit.

---

### Task 1: quoteBreakdown helper (km strip + per-leg prices)

**Files:**
- Create: `api/src/quote/breakdown.ts`
- Test: `api/src/quote/breakdown.test.ts`

**Interfaces:**
- Consumes: `billableKm`, `legPriceCents` from `./private`; `QuoteRequest`, `Vehicle` from `./types`/`./rateCard`.
- Produces:
  - `interface LegBreakdown { from: string; to: string; distanceKm: number; billableKm: number; priceCents: number }`
  - `interface QuoteBreakdown { km: { distanceKm: number; bufferKm: number; billableKm: number }; legs: LegBreakdown[] }`
  - `function quoteBreakdown(req: QuoteRequest): QuoteBreakdown`

- [ ] **Step 1: Write the failing test**

Create `api/src/quote/breakdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { quoteBreakdown } from './breakdown';
import type { QuoteRequest } from './types';

describe('quoteBreakdown', () => {
  it('private: per-leg billable + price and km totals (140km van = 12782¢)', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'van', pax: 4, bags: 4, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 140 }] };
    const b = quoteBreakdown(req);
    expect(b.legs).toEqual([{ from: 'Kandy', to: 'Ella', distanceKm: 140, billableKm: 154, priceCents: 12782 }]);
    expect(b.km).toEqual({ distanceKm: 140, bufferKm: 14, billableKm: 154 });
  });

  it('private: floor applies on a short leg (car, 20km → floor 2900¢)', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ from: 'A', to: 'B', distanceKm: 20 }] };
    const b = quoteBreakdown(req);
    expect(b.legs[0].priceCents).toBe(2900); // max(floor, round(22*46))
    expect(b.km.billableKm).toBe(22);
  });

  it('chauffeur: uses travelDays for the per-leg breakdown', () => {
    const req: QuoteRequest = {
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-16',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Ella', distanceKm: 140 },
      ],
    };
    const b = quoteBreakdown(req);
    expect(b.legs.map((l) => l.distanceKm)).toEqual([120, 140]);
    expect(b.km.distanceKm).toBe(260);
    expect(b.km.billableKm).toBe(billableSum(120) + billableSum(140));
  });
});

function billableSum(km: number): number { return Math.round(km * 1.1); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run src/quote/breakdown.test.ts`
Expected: FAIL — `Cannot find module './breakdown'`.

- [ ] **Step 3: Write minimal implementation**

Create `api/src/quote/breakdown.ts`:

```ts
import { billableKm, legPriceCents } from './private';
import type { QuoteRequest } from './types';

export interface LegBreakdown {
  from: string;
  to: string;
  distanceKm: number;
  billableKm: number;
  priceCents: number;
}
export interface QuoteBreakdown {
  km: { distanceKm: number; bufferKm: number; billableKm: number };
  legs: LegBreakdown[];
}

// UI-facing breakdown computed from the engine's own primitives — the km strip and per-leg
// prices the Summary/timeline show. Deliberately NOT part of the core quote() result (P8).
export function quoteBreakdown(req: QuoteRequest): QuoteBreakdown {
  const vehicle = 'vehicle' in req && req.vehicle === 'van' ? 'van' : 'car';
  const src =
    req.product === 'chauffeur' ? req.travelDays : req.product === 'private' ? req.legs : [];
  const legs: LegBreakdown[] = src.map((l) => {
    const bKm = billableKm(l.distanceKm);
    return { from: l.from, to: l.to, distanceKm: l.distanceKm, billableKm: bKm, priceCents: legPriceCents(bKm, vehicle) };
  });
  const distanceKm = legs.reduce((s, l) => s + l.distanceKm, 0);
  const billable = legs.reduce((s, l) => s + l.billableKm, 0);
  return { km: { distanceKm, bufferKm: billable - distanceKm, billableKm: billable }, legs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run src/quote/breakdown.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/breakdown.ts api/src/quote/breakdown.test.ts
git commit -m "feat(quote-tool): quoteBreakdown helper (km strip + per-leg prices)"
```

---

### Task 2: Map the design leg model → engine request (categories, stays, fees, vehicle tiers)

**Files:**
- Modify: `api/src/routes/internalQuote.ts`
- Modify: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `quote`, `resolveAndPrice`, `PriceError`, `RATE_CARD`, `ExtraCode`, `Vehicle`.
- Produces: updated `ToolLeg`/`ToolRequest` shapes and `toEngineRequest` that accepts the design model. Vehicle gating: `van_9`/`van_14`/`custom` ⇒ `PriceError(400)`.

This replaces the old `type`/`sightseeing`/`waiting` leg fields with the design's `category`/`addSightseeingFee`/`addWaitingFee`/`hasDriver`/`hasCarStay`. Existing tool tests that used the old shape are updated in this task.

- [ ] **Step 1: Write the failing tests**

Add to `api/src/routes/internalQuote.test.ts` (and update any existing test that used `type:`/`sightseeing:`/`waiting:` on a leg to the new field names — `category:`, `addSightseeingFee:`, `addWaitingFee:`):

```ts
  it('derives chauffeur when a leg has a stay day or a driver/car stay', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'stay_day', from: 'Kandy', to: 'Kandy', date: '2026-02-15' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).product).toBe('chauffeur');
  });

  it('a plain transfer itinerary is private', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'van_6', passengerCount: 4, luggageCount: 4, legs: [{ category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 }],
    });
    const d = await res.json();
    expect(d.product).toBe('private');
    expect(d.total.cents).toBe(12782); // van 140km
  });

  it('a leg sightseeing/waiting toggle and safari_wait category add engine extras', async () => {
    const base = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80 }] })).json();
    const withFees = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80, addSightseeingFee: true, addWaitingFee: true }] })).json();
    expect(withFees.total.cents).toBe(base.total.cents + 1000 + 1000); // sightseeing $10 + waiting $10
  });

  it('gates van_9/van_14/custom vehicles until rates exist (400)', async () => {
    for (const vehicle of ['van_9', 'van_14', 'custom']) {
      const res = await post(createApp(), '/admin/quote/estimate', { vehicle, passengerCount: 6, luggageCount: 6, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80 }] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/rate/i);
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: FAIL — new field names not mapped; gating not implemented.

- [ ] **Step 3: Rewrite the tool leg model + mapping in `internalQuote.ts`**

Replace the `LEG_TYPES`, `ToolLeg`, `ToolRequest`, `collectExtras`, and `toEngineRequest` sections with:

```ts
// Design leg categories. `drives` = the vehicle moves that day (km-priced); stay_day is idle.
const CATEGORIES: Record<string, { drives: boolean }> = {
  transfer: { drives: true },
  airport: { drives: true },
  train_support: { drives: true },
  sightseeing: { drives: true },
  safari_wait: { drives: true },
  stay_day: { drives: false },
};

// Tool vehicle tiers → engine vehicle class. Bigger tiers are gated until rates exist.
const VEHICLE_MAP: Record<string, Vehicle | null> = {
  car: 'car', van_6: 'van', van_9: null, van_14: null, custom: null,
};

interface ToolLeg {
  category?: string;
  date?: string;
  from: string;
  to: string;
  distanceKm?: number;
  addSightseeingFee?: boolean;
  addWaitingFee?: boolean;
  hasDriver?: boolean;
  hasCarStay?: boolean;
}
interface ToolRequest {
  name?: string;
  contact?: string;
  notes?: string;
  vehicle: string; // design tier id
  passengerCount: number;
  luggageCount: number;
  legs: ToolLeg[];
}

function drives(l: ToolLeg): boolean {
  return CATEGORIES[l.category || 'transfer']?.drives ?? true;
}
function isChauffeur(legs: ToolLeg[]): boolean {
  return legs.some((l) => (l.category || 'transfer') === 'stay_day' || l.hasDriver || l.hasCarStay);
}
function collectExtras(legs: ToolLeg[]): ExtraCode[] {
  const out: ExtraCode[] = [];
  for (const l of legs) {
    if (l.addSightseeingFee) out.push('sightseeing');
    if (l.addWaitingFee) out.push('waiting');
    if ((l.category || 'transfer') === 'safari_wait') out.push('safari-wait');
  }
  return out;
}

function toEngineRequest(req: ToolRequest): QuoteRequest {
  const vehicle = VEHICLE_MAP[req.vehicle];
  if (!vehicle) throw new PriceError(`no rate is set for "${req.vehicle}" yet — pick Car or Van 6, or add its rate`, 400);
  const extras = collectExtras(req.legs);
  const driving = req.legs.filter(drives);
  if (isChauffeur(req.legs)) {
    const dated = req.legs.map((l) => l.date).filter(Boolean) as string[];
    if (dated.length < 1) throw new PriceError('chauffeur trips need dates on the legs (to count the days)', 400);
    const sorted = [...dated].sort();
    return {
      product: 'chauffeur', vehicle, firstDate: sorted[0], lastDate: sorted[sorted.length - 1],
      travelDays: driving.map((l) => ({ date: l.date || sorted[0], from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })),
      extras,
    };
  }
  return {
    product: 'private', vehicle, pax: req.passengerCount, bags: req.luggageCount,
    legs: driving.map((l) => ({ from: l.from, to: l.to, distanceKm: Number(l.distanceKm) })), extras,
  };
}
```

Then update `resolveAndPrice` to use `drives(l)` instead of the old `LEG_TYPES[...]?.drives`, and its "add at least one travel leg" guard to use `req.legs.filter(drives)`. Update the draft generators (`whatsappDraft`/`emailDraft`/`notionDraft`) and `legLabel` to read `l.category`/`drives(l)` instead of `l.type`. Update `shape()`/`/estimate` to pass through `body.passengerCount`/`luggageCount`/`vehicle` unchanged (they now live on `ToolRequest`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS (new + updated existing).

- [ ] **Step 5: Full gate + commit**

```bash
cd api && npm run check
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quote-tool): map design leg model to engine (categories, stays, fees, vehicle tiers)"
```

---

### Task 3: `/estimate` returns breakdown; `GET /rate-card` read-only view

**Files:**
- Modify: `api/src/routes/internalQuote.ts`
- Modify: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `quoteBreakdown` (Task 1); `RATE_CARD`.
- Produces: `/estimate` response gains `breakdown: QuoteBreakdown`; new `GET /admin/quote/rate-card` returns the display rate card.

- [ ] **Step 1: Write the failing tests**

Add to `api/src/routes/internalQuote.test.ts`:

```ts
  it('estimate includes a breakdown (km strip + per-leg prices)', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'van_6', passengerCount: 4, luggageCount: 4, legs: [{ category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 }] })).json();
    expect(d.breakdown.km).toEqual({ distanceKm: 140, bufferKm: 14, billableKm: 154 });
    expect(d.breakdown.legs[0].priceCents).toBe(12782);
  });

  it('GET /rate-card returns the locked rate card for the read-only Settings', async () => {
    const d = await (await createApp().request('/admin/quote/rate-card')).json();
    expect(d.version).toBe('2026-06-28');
    expect(d.perKmCents).toEqual({ car: 46, van: 83 });
    expect(d.floorCents).toEqual({ car: 2900, van: 5000 });
    expect(d.chauffeurDayRateCents).toBe(3500);
    expect(d.fxUsdToLkr).toBe(320);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts -t "breakdown|rate-card"`
Expected: FAIL — `breakdown` undefined; `/rate-card` 404.

- [ ] **Step 3: Implement**

In `internalQuote.ts`: import `quoteBreakdown` from `../quote/breakdown`. In the `/estimate` success path add `breakdown: quoteBreakdown(req)` to the JSON (where `req` is the engine request from `resolveAndPrice`). Add the route (registered after the auth guard):

```ts
  r.get('/rate-card', (c) =>
    c.json({
      version: RATE_CARD.version,
      perKmCents: RATE_CARD.perKmCents,
      floorCents: RATE_CARD.floorCents,
      chauffeurDayRateCents: RATE_CARD.chauffeur.dayRateCents,
      bufferPct: RATE_CARD.bufferPct,
      depositPct: RATE_CARD.deposit.pct,
      extras: RATE_CARD.extras,
      fxUsdToLkr: RATE_CARD.fxUsdToLkr,
    }),
  );
```

Also add `breakdown` to `/save`'s pricing is not required (save persists the engine result); only `/estimate` needs it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
cd api && npm run check
git add api/src/routes/internalQuote.ts api/src/routes/internalQuote.test.ts
git commit -m "feat(quote-tool): /estimate breakdown + GET /rate-card read-only view"
```

---

### Task 4: Front-end shell — CSS, header, status, card scaffold, state model, api() wiring

**Files:**
- Rewrite: `api/src/routes/quote-tool.html`

**Interfaces:**
- Consumes endpoints: `GET /places?q`, `POST /distance`, `POST /estimate`, `GET /rate-card`, `POST /save`, `GET /list`, `PATCH /:id` — all via a key-aware `api()` wrapper (attach `x-admin-key` from `localStorage['chAdminKey']`; on 401 prompt once, store, retry).
- Produces: the page skeleton + a global `state` (the design `quote` object per extraction §2.1/§2.2, minus editable settings) + `render()` loop + `api()` helper. Later tasks fill the cards.

This is a from-scratch rewrite. Reproduce the design faithfully; the extraction doc is the contract.

- [ ] **Step 1: Build the shell**

Replace `api/src/routes/quote-tool.html` with a single HTML file that:
1. Loads Google Fonts (Bodoni Moda 500–800, Poppins 400–700) and inlines the **entire** CSS from `docs/qgen-design-extraction.md` §1 verbatim in a `<style>` block.
2. Renders the design App shell from §3.1: `.ch-app` → sticky `.ch-header` (brand mark "C", "Ceylon Hop / Ops · Quote Generator", status pill `<select>` with options Draft/Sent/Booked/Lost/Expired, `New`, `Save`, and Copy WhatsApp/Email/Notion buttons) → `.ch-container > .ch-main` (left col: Customer, Rate Settings, Itinerary cards; right col sticky: Summary, Flags) → `.ch-output-wrap` (Output card) → `.ch-toast`.
3. Defines `state` = the design `quote` object (§2.1): `{ id, customerName:'', contact:'', passengerCount:2, luggageCount:2, vehicleType:'van_6', outputCurrency:'LKR', status:'draft', internalNotes:'', legs:[newLeg()] }` (no `settings` — rates are server-side/read-only). `newLeg()` per §2.2 (category:'transfer', empty locations, stopovers:[], distanceKm:0, manualDistance:false, autoMatched:false, addSightseeingFee:false, addWaitingFee:false, hasDriver:false, hasCarStay:false, notes:'', date:'').
4. Defines the key-aware `api(path, opts)` wrapper (attach `x-admin-key` from localStorage if set; on 401 → prompt → store → retry once) and thin callers `apiPlaces(q)`, `apiDistance(from,to)`, `apiEstimate(payload)`, `apiRateCard()`, `apiSave(payload)`, `apiList(filter)`, `apiPatch(id,patch)`.
5. A single `render()` that redraws from `state`, and a `mutate(patch)`/`updateLeg(id,patch)`/`addLeg(cat)`/`removeLeg(id)`/`dupLeg(id)` set (per §App mutators). Cards may render as empty placeholders in this task.
6. Escapes all interpolated server/user strings with an `esc()` helper wherever they go into innerHTML.

- [ ] **Step 2: Verify the shell loads**

Start the API (`cd api && npm run dev`), open `http://localhost:8787/admin/quote`, confirm the header, three left cards + two right cards + output card render with the design's cream/teal styling and no console errors (`preview_console_logs`). Screenshot for the record.

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/quote-tool.html
git commit -m "feat(quote-tool): port design shell — CSS, header, status, cards scaffold, state + api()"
```

---

### Task 5: CustomerCard + read-only SettingsCard

**Files:**
- Modify: `api/src/routes/quote-tool.html`

**Interfaces:**
- Consumes: `state`, `mutate`, `apiRateCard`, extraction §3.2/§3.3.

- [ ] **Step 1: Build CustomerCard (§3.2)**

"① Customer & Request" (icon ①, accent blue): row 1 = Customer name (→ `customerName`), Passengers (num, prefix 👥, → `passengerCount`), Bags/luggage (num, prefix 🧳, → `luggageCount`); row 2 = Vehicle type (select over `CH.VEHICLES` labels: Car / Van 6 Seat / Van 9 Seat / Van 14 Seat / Custom → `vehicleType`); the conditional luggage>3-with-car warning banner (verbatim copy from §3.2); a WhatsApp/email `contact` input; and the "Internal notes" textarea (→ `internalNotes`). Required-field hints for passengers/luggage/vehicle.

- [ ] **Step 2: Build SettingsCard read-only (§3.3, decision P4)**

"② Rate Settings" (icon ②, accent black, collapsible, starts closed). NO admin toggle, NO editable inputs. Body = the `ch-lock-note` ("Rates are locked and server-authoritative — the engine prices every quote.") followed by a read-only rendering of `apiRateCard()`: per-km (Car Rs{car×fx/100... show as `$0.46 / km` and the LKR equiv}, Van), floors (Car $29 / Van $50), chauffeur day rate ($35), buffer (10%), deposit (10%), the extras list (sightseeing/waiting/safari-wait with their $), and the FX rate (Rs 320/$). Use the design's `ch-rate-grid`/`ch-rate-row`/`ch-rate-label` classes with the value as static text (no inputs). Fetch the rate card once on load and cache it.

- [ ] **Step 3: Verify**

Reload the tool; confirm Customer card edits update state (type a name, change vehicle to Car with 4 bags → warning shows), and the Settings card expands to show the locked rates from `/rate-card`. Screenshot.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/quote-tool.html
git commit -m "feat(quote-tool): CustomerCard + read-only SettingsCard (locked rate card)"
```

---

### Task 6: ItineraryCard timeline (leg cards, autocomplete, stays, fees, notes)

**Files:**
- Modify: `api/src/routes/quote-tool.html`

**Interfaces:**
- Consumes: `state.legs`, `updateLeg`/`addLeg`/`removeLeg`/`dupLeg`, `apiPlaces`, `apiDistance`, extraction §3.4.

- [ ] **Step 1: Build the timeline (§3.4 + §3.4.1)**

"③ Itinerary" (icon ③, accent orange, no body padding, right badge "{N} stops · {D} driver nights"). Reproduce the timeline: rail markers (first=teal, last=red, middle=ring, stay_day=dashed moon), per-leg `ch-tl-card` with: category `<select>` (CH.CATEGORIES labels), duplicate/remove icon buttons; From → Destination place inputs (or single "Staying at" for stay_day) using an **offline+server autocomplete** — call `apiPlaces(q)` (server) for suggestions, render the `ch-ac-menu`; stopover chips (`ch-stops`) with add-on-Enter; date input; distance area with three states (manual km+hr / auto pill `≈ {km} km` / "No distance" warn) — on from+to change (non-manual), call `apiDistance(from,to)` and set `distanceKm` + `autoMatched`; per-leg price display (`ch-meta-price`, filled from the last `/estimate` breakdown by leg index); driver-stays/car-stays toggles (`hasDriver`/`hasCarStay`); sightseeing/waiting fee checkboxes (`addSightseeingFee`/`addWaitingFee`) — the fee amount shown is the rate card's extra value, **read-only** (P5); conditional note input. Connectors between legs. The add-leg row (Add transfer / Add stay day / Add sightseeing) and the driver/car-stay hint. `addLeg` copies prev dropoff → new pickup and +1 day (§3.4).

- [ ] **Step 2: Verify**

Reload; add legs, type "Kand" → pick Kandy from the server autocomplete → "Ella" → confirm distance auto-fills; toggle a stay day and confirm the marker/connector change; add a stopover chip. Screenshot. Confirm no console errors.

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/quote-tool.html
git commit -m "feat(quote-tool): itinerary timeline — legs, autocomplete, stays, fees, notes"
```

---

### Task 7: SummaryCard + FlagsCard (from /estimate + client flags)

**Files:**
- Modify: `api/src/routes/quote-tool.html`

**Interfaces:**
- Consumes: `apiEstimate`, `state`, extraction §3.5/§3.6/§4, the `/estimate` response (`total`, `deposit`, `amountDueNow`, `margin`, `lineItems[{label,usd,lkr}]`, `breakdown`, `warnings`, `comparison`).

- [ ] **Step 1: Wire pricing + Summary (§3.5, P5)**

On any state change that affects price (legs, vehicle, pax/bags, fees, stays, dates), debounce and call `apiEstimate(toPayload(state))` where `toPayload` sends `{ vehicle:vehicleType, passengerCount, luggageCount, legs }`. Gate: if `vehicleType` ∈ {van_9,van_14,custom}, skip the call and show a "rate needed" note in the Summary instead. Render SummaryCard "④ Pricing Summary" (icon ④, blue, badge "LKR · internal"): the km-strip from `breakdown.km` (distance / +buffer / billable hero); the cost build-up from the engine `lineItems` (label + LKR value) then Quote total (`total.lkr`) and `Est. margin {margin.lkr}`; deposit + amount-due-now when chauffeur. Fill each leg's `ch-meta-price` from `breakdown.legs[i].priceCents` (converted via fx). Keep the design's "line items vs total" tip only if we surface both (we show the engine total; omit that tip). Add the car-vs-van compare block from `comparison`.

- [ ] **Step 2: Build FlagsCard (§3.6 + §4)**

"⑤ Operational Flags" (icon ⑤, orange). Compute client-side UI flags per §4 that need no pricing: car-luggage-limit (car & luggage>3, red), capacity (pax>veh.pax or bags>veh.bags, orange), airport-timing (category airport or /airport|cmb|katunayake/, blue), stopover-included (blue), driver-without-car (hasDriver && !hasCarStay, orange), safari-waiting (blue), hectic-itinerary (3+ consecutive dated driving legs, orange), long-drive (any leg `driveTimeHours>=6` from `/distance` duration, red), check-distances (driving leg with no distance, blue). Merge engine `warnings` as extra flags. "All clear" state when none.

- [ ] **Step 3: Verify**

Reload; build a Kandy→Ella van itinerary → Summary shows LKR total (12,782-based) + km strip + per-leg price; set car with 4 bags → red luggage flag; add a 3rd consecutive day → hectic flag. Screenshot.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/quote-tool.html
git commit -m "feat(quote-tool): Summary (engine breakdown) + client-side Flags"
```

---

### Task 8: OutputCard tabs + templates + lifecycle (Save/Recent/status)

**Files:**
- Modify: `api/src/routes/quote-tool.html`
- Modify: `web-tests/e2e/quote-tool.spec.js`

**Interfaces:**
- Consumes: `apiSave`, `apiList`, `apiPatch`, extraction §3.7/§5, the priced result + `state`.

- [ ] **Step 1: Build OutputCard (§3.7 + §5)**

"⑥ Quote Output" (icon ⑥, teal). Four tabs: Internal Calc, WhatsApp (default), Email, Notion. Currency toggle (LKR/USD, → `outputCurrency`, display-only via fx) shown for non-internal tabs, plus a Copy button. Port `whatsappMessage`/`emailMessage`/`notionTable` (§5) verbatim as client-side builders over the priced result — per-leg rows use `breakdown.legs` prices and `routeText(leg)`; `M(cents)` converts to LKR or USD via fx. Internal tab = the `InternalView` grid + `ch-itable` (§3.7). The header Copy WhatsApp/Email/Notion buttons copy the same strings.

- [ ] **Step 2: Wire lifecycle**

Header `Save` → `apiSave(savePayload(state))` (`{ name:customerName, contact, vehicle:vehicleType, passengerCount, luggageCount, legs, notes:internalNotes }`); on success toast "Saved as {reference}" and refresh a Recent-quotes list. Header status `<select>` (Draft/Sent/Booked/Lost/Expired ↔ draft/sent/won/lost/expired) → on change, if the quote is saved, `apiPatch(id,{status})`. Add a compact "Recent quotes" area (from `apiList()`), each row showing reference/customer/total/status with a status control that PATCHes. `New` → reset `state` to a fresh quote.

- [ ] **Step 3: Rewrite the e2e (Playwright)**

Replace `web-tests/e2e/quote-tool.spec.js` with specs for the ported UI:
```js
import { test, expect } from '@playwright/test';
const TOOL = 'http://localhost:8787/admin/quote';

test('timeline → autocomplete → auto-distance → priced summary → save → recent', async ({ page }) => {
  await page.goto(TOOL);
  await expect(page.locator('.ch-brand-txt b')).toHaveText('Ceylon Hop');
  const from = page.locator('.ch-tl-card .ch-tl-title').first();
  await from.click(); await from.fill('Kand');
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: 'Kandy' }).first().click();
  const to = page.locator('.ch-tl-card .ch-tl-title').nth(1);
  await to.click(); await to.fill('Ella');
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: 'Ella' }).first().click();
  await expect(page.locator('.ch-km.hero b')).not.toHaveText('0'); // billable km computed
  await expect(page.locator('.ch-line.strong .ch-line-val')).toContainText('LKR');
  await page.fill('#ch-customer', 'E2E Port');
  await page.locator('.ch-header-tools', { hasText: 'Save' }).getByText('Save').click();
  await expect(page.locator('.ch-toast')).toContainText('Q-');
});

test('car + 4 bags raises the luggage flag', async ({ page }) => {
  await page.goto(TOOL);
  await page.selectOption('#ch-vehicle', { label: 'Car' });
  await page.fill('#ch-bags', '4');
  await expect(page.locator('.ch-flag', { hasText: 'luggage' }).first()).toBeVisible();
});
```
(Adjust selector ids to those you used; keep the assertions — priced LKR summary, save reference, luggage flag.)

- [ ] **Step 4: Run the e2e**

Run: `cd web-tests && npx playwright test quote-tool.spec.js`
Expected: PASS (both specs). Then `cd api && npm run check` green.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/quote-tool.html web-tests/e2e/quote-tool.spec.js
git commit -m "feat(quote-tool): output tabs + templates + lifecycle (save/recent/status) + e2e"
```

---

## Self-Review

**Spec coverage:**
- Port 1:1 vanilla JS (P1) → Tasks 4–8. ✅
- Derive service from legs (P2) → Task 2 (`isChauffeur`). ✅
- Engine is the price (P3) → Tasks 3, 7 (no client compute). ✅
- Read-only rate settings (P4) → Task 5. ✅
- Summary reflects engine structure (P5) → Task 7. ✅
- Backend statuses w/ labels (P6) → Tasks 4, 8. ✅
- Vehicle tier gating (P7) → Task 2 (server) + Task 7 (client). ✅
- No core-engine change (P8) → Task 1 (breakdown from primitives). ✅
- Lifecycle save/list/status (P9) → Task 8. ✅
- Model mapping (categories/extras/chauffeur/vehicle) → Task 2. ✅
- Breakdown (km strip + per-leg) → Task 1, surfaced Task 3. ✅
- Rate-card exposure → Task 3. ✅
- Flags (client + engine warnings) → Task 7. ✅
- Output templates → Task 8. ✅

**Placeholder scan:** Backend tasks (1–3) carry full code. Front-end tasks (4–8) point at `docs/qgen-design-extraction.md` sections as the verbatim source (CSS/components/templates) plus inline wiring code — the design detail is the extraction doc by reference, not a TODO.

**Type consistency:** `ToolLeg`/`ToolRequest` fields (`category`, `addSightseeingFee`, `addWaitingFee`, `hasDriver`, `hasCarStay`, `passengerCount`, `luggageCount`, `vehicle`) are defined in Task 2 and used consistently in Tasks 3, 7, 8. `quoteBreakdown` shape (`km{distanceKm,bufferKm,billableKm}`, `legs[{from,to,distanceKm,billableKm,priceCents}]`) defined Task 1, consumed Tasks 3, 7. `VEHICLE_MAP` gating (`van_9/van_14/custom → null`) consistent Task 2 (server) / Task 7 (client skip).

**Note on front-end granularity:** Tasks 4–8 edit one large file sequentially (no parallel conflict). Each has a concrete verify step (preview + screenshot) and the flow is proven end-to-end by the Task 8 e2e.
