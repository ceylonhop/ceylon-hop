# Customer Quote Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only customer-facing quote page at `quote.ceylonhop.com/q?t=…` that shows the trip on a map, day by day, with one or both service prices — and hands off to WhatsApp, never to a payment.

**Architecture:** A new following token (no revision, no seq — it cannot pin by construction) keys a single read-only endpoint `GET /quote-view`, which builds its response from a new pure projection `customerQuoteView` extracted alongside `payPageCopy`. A new static page `quote.html` is served from the API host by `customerPages.ts`, exactly as `pay.html` is, so a second custom domain on the same service is same-origin with the API. Nothing in this feature can start a payment.

**Tech Stack:** TypeScript · Hono · Drizzle (Postgres) · Vitest (`api/`) · Vitest + Playwright (`web-tests/`) · vanilla ES5-style browser JS in the static pages (match `pay.html`).

## Global Constraints

- **Margin never reaches the wire.** No response in this feature may include `marginCents`, `marginEstimateCents`, `rateCardJson`, or `lineItems[].meta.hotZone`. Assert this in every projection test.
- **This module never writes.** `quoteView.ts` has no POST and no repo mutation. Every write in this feature happens where the customer cannot reach it: the ops mint (`customerTotal`) and the existing `/quote-pay/start`.
- **No pay button, no payment path.** The page's only actions are `wa.me` links (spec D6).
- **Money is integer cents** everywhere server-side; format to USD only at the view boundary.
- **WhatsApp number is `94779669662`** — the number already hard-coded in `pay.html`.
- **Prettier/ESLint:** run `npm run check` in `api/` before every commit that touches `api/`.
- **Migrations auto-apply on Render boot, fail-closed** — merging a migration IS its release. Every new column must be nullable with no backfill required.
- **Commit style:** conventional prefix, imperative, no scope. End every commit body with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Work happens in the worktree** `/Users/roshenw/claude_code/ceylon-hop-quote-link` on branch `docs/customer-quote-link`. Never `git add -A` — the main tree is shared with other sessions.

---

## File Structure

| File | Responsibility |
|---|---|
| `api/drizzle/0041_quote_offer_validity.sql` | **Create.** Adds `quotes.offer_valid_until`. |
| `api/src/db/schema.ts` | **Modify.** Declare the new column. |
| `api/src/db/quoteRepo.ts` | **Modify.** `offerValidUntil` on `SavedQuote` + `QuotePatch`; in-memory repo honours it. |
| `api/src/db/postgresQuoteRepo.ts` | **Modify.** Read/write the new column. |
| `api/src/quote/quoteDays.ts` | **Create.** Pure day-row builder, including gap-day synthesis. |
| `api/src/quote/customerQuoteView.ts` | **Create.** The margin-safe view-model. Wraps `payPageCopy`, adds days, map stops, options, WhatsApp prefills. |
| `api/src/lib/bookingToken.ts` | **Modify.** `signQuoteViewToken` / `verifyQuoteViewToken`, purpose byte `0x02`. |
| `api/src/routes/quoteView.ts` | **Create.** `GET /quote-view` — state machine, `no-store`, soft-unavailable. |
| `api/src/routes/internalQuote.ts` | **Modify.** `POST /:id/quote-link` mint; stamp `offerValidUntil` on `→ ready`. |
| `api/src/config.ts` | **Modify.** `QUOTE_BASE_URL`. |
| `api/src/app.ts` | **Modify.** Resolve `quoteBaseUrl`, mount `quoteViewRoutes`, pass to `customerPages`/`internalQuote`. |
| `api/src/routes/customerPages.ts` | **Modify.** Serve `quote.html` at `/q`; add `quote.css` + `ch-map.js` to assets. |
| `quote.html`, `quote.css` | **Create.** The page (repo root, beside `pay.html`). |
| `api/src/routes/ops-ui.html` | **Modify.** "Quote link" button beside "Payment link". |

---

## Task 1: The offer-validity column

**Files:**
- Create: `api/drizzle/0041_quote_offer_validity.sql`
- Modify: `api/src/db/schema.ts`, `api/src/db/quoteRepo.ts`, `api/src/db/postgresQuoteRepo.ts`
- Test: `api/src/db/quoteRepo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SavedQuote.offerValidUntil: Date | null`; `QuotePatch.offerValidUntil?: Date | null`.

- [ ] **Step 1: Write the failing test**

Append to `api/src/db/quoteRepo.test.ts`:

```ts
it('round-trips offerValidUntil through patch', async () => {
  const repo = new InMemoryQuoteRepo();
  const saved = await repo.save(baseQuoteInput());
  expect(saved.offerValidUntil).toBeNull();
  const when = new Date('2026-08-12T00:00:00Z');
  const patched = await repo.patch(saved.id, { offerValidUntil: when });
  expect(patched!.offerValidUntil?.toISOString()).toBe(when.toISOString());
});
```

If `baseQuoteInput()` does not already exist in that file, use whatever fixture builder the neighbouring tests use — read the top of the file first and match it exactly.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && npx vitest run src/db/quoteRepo.test.ts -t offerValidUntil
```

Expected: FAIL — `offerValidUntil` is not a property of the returned object (`undefined`, not `null`).

- [ ] **Step 3: Write the migration**

Create `api/drizzle/0041_quote_offer_validity.sql`:

```sql
-- Offer validity (spec 2026-08-05 D9). How long the PRICE is honoured, as distinct from how
-- long the quote link works — link liveness is status-driven (D8) and has no clock.
--
-- Set on the transition into `ready` as approval + 7 days, reset on re-approval. Nullable:
-- every quote predating this renders with it null, which the page treats as "no validity
-- shown" rather than "lapsed". Deliberately NOT rate_locked_until: ops quotes lock at
-- approval with rate_locked_until = null, which is exactly why this column has to exist.
ALTER TABLE "quotes" ADD COLUMN "offer_valid_until" timestamptz;
```

- [ ] **Step 4: Declare the column in the schema**

In `api/src/db/schema.ts`, immediately after the `requestedService: text('requested_service'),` line, add:

```ts
  // Offer validity (spec 2026-08-05 D9): how long the PRICE is honoured. Distinct from link
  // liveness, which is status-driven and has no clock. Stamped on → ready as approval + 7 days.
  offerValidUntil: timestamp('offer_valid_until', { withTimezone: true }),
```

- [ ] **Step 5: Thread it through the repo types**

In `api/src/db/quoteRepo.ts`:

1. In the `QuotePatch` interface (the one already carrying `requestedService?: string | null;`), add:

```ts
  // Offer validity (spec 2026-08-05 D9). Stamped on → ready; null = no validity recorded.
  offerValidUntil?: Date | null;
```

2. In **both** `SavedQuote` and `QuoteSummary`-adjacent interfaces that already declare `requestedService: string | null;`, add alongside it:

```ts
  offerValidUntil: Date | null;
```

3. In the in-memory row builder — the same place that does `requestedService: q.requestedService ?? null,` — add `offerValidUntil: q.offerValidUntil ?? null,`.

4. In the in-memory `patch()`, beside the other optional field assignments, add:

```ts
    if (args.offerValidUntil !== undefined) row.offerValidUntil = args.offerValidUntil;
```

5. In `update()` — the method that bumps `revision` — do **not** touch `offerValidUntil`. A content edit changes the price, and the validity window belongs to the approval that follows.

In `api/src/db/postgresQuoteRepo.ts`, add `offerValidUntil: r.offerValidUntil ?? null,` everywhere the mapper already maps `requestedService`, and include the column in the select projection beside `requestedService: quotes.requestedService`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd api && npx vitest run src/db/quoteRepo.test.ts -t offerValidUntil
```

Expected: PASS.

- [ ] **Step 7: Full check and commit**

```bash
cd api && npm run check
```

Expected: typecheck, lint and the whole suite pass.

```bash
git add api/drizzle/0041_quote_offer_validity.sql api/src/db/schema.ts api/src/db/quoteRepo.ts api/src/db/postgresQuoteRepo.ts api/src/db/quoteRepo.test.ts
git commit -m "$(cat <<'EOF'
feat: store an offer-validity date on quotes

How long the PRICE is honoured, distinct from how long the link works.
Ops quotes lock at approval with rate_locked_until = null, so there was
no existing clock to expire an offer against.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Day rows with gap-day synthesis

**Files:**
- Create: `api/src/quote/quoteDays.ts`
- Test: `api/src/quote/quoteDays.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface QuoteDayRow {
  kind: 'journey' | 'stay';
  date: string;              // 'WED 20 AUG', or 'MON 25 – WED 27 AUG' for a collapsed stay
  title: string;             // 'Colombo Airport → Sigiriya' | 'In Ella'
  meta: string | null;       // '168 km · about 4 h' — journeys only, never a price
  stops: string[];           // intermediate stop names, [] when not a multi-stop leg
}
export function quoteDays(quote: { request: unknown }): QuoteDayRow[];
```

- [ ] **Step 1: Write the failing tests**

Create `api/src/quote/quoteDays.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { quoteDays } from './quoteDays';

const q = (legs: unknown[]) => ({ request: { tool: { legs } } });

describe('quoteDays', () => {
  it('renders a journey row with distance and duration, never a price', () => {
    const rows = quoteDays(q([{ from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 }]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'journey', date: 'WED 20 AUG', title: 'Colombo Airport → Sigiriya' });
    expect(rows[0].meta).toBe('168 km · about 4 h');
    expect(JSON.stringify(rows)).not.toMatch(/\$|cents|price/i);
  });

  it('synthesizes the days between legs as stays at the last place reached', () => {
    const rows = quoteDays(q([
      { from: 'Colombo', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
      { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
    ]));
    expect(rows.map((r) => r.title)).toEqual(['Colombo → Sigiriya', 'In Sigiriya', 'Sigiriya → Kandy']);
    expect(rows[1]).toMatchObject({ kind: 'stay', date: 'THU 21 AUG', meta: null });
  });

  it('collapses consecutive synthesized stays into one range row', () => {
    const rows = quoteDays(q([
      { from: 'Kandy', to: 'Ella', date: '2026-08-24', distanceKm: 140 },
      { from: 'Ella', to: 'Colombo Airport', date: '2026-08-28', distanceKm: 212 },
    ]));
    expect(rows.map((r) => r.title)).toEqual(['Kandy → Ella', 'In Ella', 'Ella → Colombo Airport']);
    expect(rows[1].date).toBe('MON 25 – WED 27 AUG');
  });

  it('renders an explicit stay_day leg as a stay', () => {
    const rows = quoteDays(q([
      { from: 'Colombo', to: 'Ella', date: '2026-08-20', distanceKm: 200 },
      { category: 'stay_day', from: 'Ella', to: 'Ella', date: '2026-08-21' },
    ]));
    expect(rows[1]).toMatchObject({ kind: 'stay', title: 'In Ella', meta: null });
  });

  it('uses the stop chain for a multi-stop leg and exposes the intermediates', () => {
    const rows = quoteDays(q([
      { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92, stops: ['Sigiriya', 'Dambulla', 'Matale', 'Kandy'] },
    ]));
    expect(rows[0].title).toBe('Sigiriya → Kandy');
    expect(rows[0].stops).toEqual(['Dambulla', 'Matale']);
  });

  it('skips synthesis entirely when any leg is undated', () => {
    const rows = quoteDays(q([
      { from: 'Colombo', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
      { from: 'Sigiriya', to: 'Kandy', distanceKm: 92 },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'journey')).toBe(true);
    expect(rows[1].date).toBe('');
  });

  it('returns [] for a legacy row with no tool legs', () => {
    expect(quoteDays({ request: {} })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd api && npx vitest run src/quote/quoteDays.test.ts
```

Expected: FAIL — `Cannot find module './quoteDays'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/quote/quoteDays.ts`:

```ts
// The customer-facing itinerary, as DAYS (spec 2026-08-05 §5.1). Pure over the stored quote —
// no repo, no clock — like payPageCopy beside it.
//
// The data only has legs, so a trip dated 20–28 with legs on 20/22/24/28 would render a section
// titled "Day by day" with days visibly missing, and a customer will count them. Every calendar
// day between the first and last leg therefore renders: days with no leg become quiet stays at
// the last place reached, and consecutive ones collapse into a range.
//
// A stay NEVER carries a price or a "rest day" framing: chauffeur idle-day pricing is
// deliberately understated in quotes and must stay that way.

export interface QuoteDayRow {
  kind: 'journey' | 'stay';
  date: string;
  title: string;
  meta: string | null;
  stops: string[];
}

interface ToolLegLite {
  from?: string;
  to?: string;
  date?: string;
  category?: string;
  distanceKm?: number;
  stops?: string[];
}

const DAY_MS = 86_400_000;

// UTC-midnight on the YYYY-MM-DD part — the same convention as payPageCopy's parseUtc and the
// engine's dayNumber, so a date here can never disagree with a date there.
function parseUtc(s: string | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(t) ? null : new Date(t);
}

// 'WED 20 AUG' — the mono row stamp, matching payPageCopy's legStamp exactly.
function stamp(d: Date): string {
  return d
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .toUpperCase()
    .replace(',', '');
}

function rangeStamp(a: Date, b: Date): string {
  return a.getTime() === b.getTime() ? stamp(a) : `${stamp(a)} – ${stamp(b)}`;
}

function endpoints(l: ToolLegLite): { from: string; to: string; mid: string[] } {
  const chain = Array.isArray(l.stops) && l.stops.length >= 2 ? l.stops : [l.from ?? '?', l.to ?? '?'];
  return { from: chain[0], to: chain[chain.length - 1], mid: chain.slice(1, -1) };
}

// "about 4 h" / "about 2 h 30" — a road-speed estimate, deliberately vague. 42 km/h is the
// engine's own working average for Sri Lankan roads; this is a reading aid, never a promise.
function durationText(km: number): string {
  const mins = Math.round((km / 42) * 60);
  const h = Math.floor(mins / 60);
  const m = Math.round((mins - h * 60) / 15) * 15;
  if (h <= 0) return `about ${Math.max(15, m)} min`;
  return m > 0 && m < 60 ? `about ${h} h ${m}` : `about ${h} h`;
}

function journeyMeta(l: ToolLegLite): string | null {
  const km = typeof l.distanceKm === 'number' && l.distanceKm > 0 ? Math.round(l.distanceKm) : null;
  return km == null ? null : `${km} km · ${durationText(km)}`;
}

const isStay = (l: ToolLegLite) => (l.category || 'transfer') === 'stay_day';

export function quoteDays(quote: { request: unknown }): QuoteDayRow[] {
  const req = (quote.request ?? {}) as { tool?: { legs?: ToolLegLite[] } };
  const legs: ToolLegLite[] = Array.isArray(req.tool?.legs) ? req.tool!.legs! : [];
  if (!legs.length) return [];

  const rowFor = (l: ToolLegLite): QuoteDayRow => {
    const { from, to, mid } = endpoints(l);
    const d = parseUtc(l.date);
    if (isStay(l)) return { kind: 'stay', date: d ? stamp(d) : '', title: `In ${to || from}`, meta: null, stops: [] };
    return { kind: 'journey', date: d ? stamp(d) : '', title: `${from} → ${to}`, meta: journeyMeta(l), stops: mid };
  };

  // Any undated leg makes calendar arithmetic meaningless — fall back to journeys-only rather
  // than invent a sequence. Tours default to blank dates, so this path is real.
  if (legs.some((l) => !parseUtc(l.date))) return legs.map(rowFor);

  const sorted = [...legs].sort((a, b) => parseUtc(a.date)!.getTime() - parseUtc(b.date)!.getTime());
  const out: QuoteDayRow[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const leg = sorted[i];
    out.push(rowFor(leg));

    const next = sorted[i + 1];
    if (!next) break;
    const from = parseUtc(leg.date)!.getTime();
    const to = parseUtc(next.date)!.getTime();
    const gapDays = Math.round((to - from) / DAY_MS) - 1;
    if (gapDays < 1) continue;

    // Where they are while nothing is scheduled: wherever this leg left them.
    const place = endpoints(leg).to;
    out.push({
      kind: 'stay',
      date: rangeStamp(new Date(from + DAY_MS), new Date(from + gapDays * DAY_MS)),
      title: `In ${place}`,
      meta: null,
      stops: [],
    });
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd api && npx vitest run src/quote/quoteDays.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd api && npm run check
git add api/src/quote/quoteDays.ts api/src/quote/quoteDays.test.ts
git commit -m "$(cat <<'EOF'
feat: build customer day rows with gap-day synthesis

A section titled "Day by day" that skips 23, 26 and 27 August invites the
customer to count them. Every calendar day between the first and last leg
now renders; days with no leg become quiet stays at the last place
reached, consecutive ones collapsed into a range. Skipped entirely when
any leg is undated, since the arithmetic would be invented.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: The customer view projection

**Files:**
- Create: `api/src/quote/customerQuoteView.ts`
- Test: `api/src/quote/customerQuoteView.test.ts`

**Interfaces:**
- Consumes: `quoteDays()` and `QuoteDayRow` (Task 2); `payPageCopy()` / `PayPageCopy` (existing, `api/src/quote/payPageCopy.ts`).
- Produces:

```ts
export interface QuoteViewOption {
  service: 'private' | 'chauffeur';
  name: string;              // 'Private transfers' | 'Chauffeur & guide'
  blurb: string;
  includedText: string;
  totalCents: number;
  totalUsd: string;          // '$840'
  deltaUsd: string | null;   // '+$340' on the non-priced option of a `both` quote
  deltaText: string | null;  // '+$340 — your driver stays with you throughout'
  cancellation: { headline: string; ladder: string[] };
  lead: boolean;             // the service that was actually priced
  waText: string;            // prefilled WhatsApp body naming this option + the reference
}

export interface CustomerQuoteView {
  reference: string;
  greetingName: string | null;
  title: string;
  subtitle: string;
  heroTotalUsd: string;
  heroTotalNote: string;
  days: QuoteDayRow[];
  mapStops: string[];
  totalKm: number | null;
  travelDays: number;
  options: QuoteViewOption[];
  waText: string;            // the page-level "anything you'd like changed" prefill
}

export function customerQuoteView(
  quote: { /* SavedQuote-shaped, see code */ },
  services: { pointToPoint: { totalCents: number } | null; chauffeur: { totalCents: number } | null },
): CustomerQuoteView;
```

- [ ] **Step 1: Write the failing tests**

Create `api/src/quote/customerQuoteView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { customerQuoteView } from './customerQuoteView';

const quote = (over: Record<string, unknown> = {}) => ({
  reference: 'Q-7F3KX',
  customerName: 'Anna Bergström',
  vehicle: 'car',
  totalCents: 84_000,
  requestedService: 'private',
  request: {
    engine: { product: 'private', firstDate: '2026-08-20', lastDate: '2026-08-28' },
    tool: {
      passengerCount: 2,
      legs: [
        { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
        { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
      ],
    },
  },
  ...over,
});

const both = { pointToPoint: { totalCents: 84_000 }, chauffeur: { totalCents: 118_000 } };
const p2pOnly = { pointToPoint: { totalCents: 84_000 }, chauffeur: null };

describe('customerQuoteView', () => {
  it('never emits margin on any path', () => {
    const v = customerQuoteView(
      quote({ marginCents: 31_000, rateCardJson: { costPerKmCents: 40 }, requestedService: 'both' }),
      both,
    );
    const s = JSON.stringify(v);
    expect(s).not.toMatch(/margin/i);
    expect(s).not.toMatch(/rateCard|costPerKm|markup|hotZone/i);
  });

  it('shows one option for a `private` quote, even when chauffeur is priceable', () => {
    const v = customerQuoteView(quote(), both);
    expect(v.options).toHaveLength(1);
    expect(v.options[0]).toMatchObject({ service: 'private', lead: true, totalUsd: '$840', deltaUsd: null });
  });

  it('shows both options for a `both` quote, priced service leading', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options.map((o) => o.service)).toEqual(['private', 'chauffeur']);
    expect(v.options[0].lead).toBe(true);
    expect(v.options[1].lead).toBe(false);
    expect(v.options[1].totalUsd).toBe('$1,180');
  });

  it('quantifies the delta on the non-priced option', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[1].deltaUsd).toBe('+$340');
    expect(v.options[1].deltaText).toBe('+$340 — your driver stays with you throughout');
  });

  it('degrades to one card when chauffeur cannot be priced on a `both` quote', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), p2pOnly);
    expect(v.options).toHaveLength(1);
    expect(v.options[0].service).toBe('private');
    expect(v.heroTotalNote).not.toMatch(/or \$/);
  });

  it('names both numbers in the hero note on a two-option quote', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.heroTotalUsd).toBe('$840');
    expect(v.heroTotalNote).toBe('private transfers · or $1,180 with your driver throughout');
  });

  it('gives each service its own cancellation ladder', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[0].cancellation.headline).toBe('Free cancellation up to 24 hours before');
    expect(v.options[1].cancellation.headline).toBe('Free cancellation up to 10 days before');
    expect(v.options[1].cancellation.ladder.join(' ')).toMatch(/80%/);
  });

  it('prefills WhatsApp with the reference and the tapped option', () => {
    const v = customerQuoteView(quote({ requestedService: 'both' }), both);
    expect(v.options[1].waText).toBe(
      "Hi! I'd like to book the Chauffeur & guide option for quote Q-7F3KX",
    );
    expect(v.waText).toContain('Q-7F3KX');
  });

  it('exposes the ordered map stops and trip stats', () => {
    const v = customerQuoteView(quote(), p2pOnly);
    expect(v.mapStops).toEqual(['Colombo Airport', 'Sigiriya', 'Kandy']);
    expect(v.totalKm).toBe(260);
    expect(v.travelDays).toBe(2);
  });

  it('renders a legacy quote with no engine without throwing', () => {
    const v = customerQuoteView(quote({ request: {} }), { pointToPoint: { totalCents: 84_000 }, chauffeur: null });
    expect(v.options).toHaveLength(1);
    expect(v.days).toEqual([]);
    expect(v.mapStops).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd api && npx vitest run src/quote/customerQuoteView.test.ts
```

Expected: FAIL — `Cannot find module './customerQuoteView'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/quote/customerQuoteView.ts`:

```ts
// The margin-safe view-model of a trip (spec 2026-08-05 D10). ONE projection, three consumers:
// the quote page, the pay page, and sendCustomerQuote's parked send-wiring — so the three
// surfaces cannot drift in how they describe the same trip.
//
// Pure over (quote, services): no repo, no clock, no request. The caller supplies both service
// totals because pricing them is the route's job (serviceChooserData against the LOCKED card);
// this file only decides what a customer is told.
//
// HAND-PICKED on purpose. The stored quote carries marginCents, the locked rate card (cost and
// markup) and hot-zone annotations; nothing here may echo `result`, `request` or `rateCardJson`.
import { payPageCopy } from './payPageCopy';
import { quoteDays, type QuoteDayRow } from './quoteDays';

export interface QuoteViewOption {
  service: 'private' | 'chauffeur';
  name: string;
  blurb: string;
  includedText: string;
  totalCents: number;
  totalUsd: string;
  deltaUsd: string | null;
  deltaText: string | null;
  cancellation: { headline: string; ladder: string[] };
  lead: boolean;
  waText: string;
}

export interface CustomerQuoteView {
  reference: string;
  greetingName: string | null;
  title: string;
  subtitle: string;
  heroTotalUsd: string;
  heroTotalNote: string;
  days: QuoteDayRow[];
  mapStops: string[];
  totalKm: number | null;
  travelDays: number;
  options: QuoteViewOption[];
  waText: string;
}

interface ViewQuote {
  reference: string;
  customerName: string | null;
  vehicle: string | null;
  totalCents: number;
  requestedService?: string | null;
  request: unknown;
}

interface ToolLegLite {
  from?: string; to?: string; date?: string; category?: string; distanceKm?: number; stops?: string[];
}

// '$840' / '$1,180' — whole dollars with a thousands separator. Quote totals are charm-finished
// to round figures; cents on a proposal would read as a bill, not an offer.
const usd = (cents: number): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

// terms.html §7. The two ladders genuinely differ, and a customer comparing two totals is
// comparing two different commitments — so each option carries its own.
const CANCELLATION = {
  private: {
    headline: 'Free cancellation up to 24 hours before',
    ladder: ['More than 24 h before pickup: full refund', 'Inside 24 h: 50% refund', 'No-show: no refund'],
  },
  chauffeur: {
    headline: 'Free cancellation up to 10 days before',
    ladder: ['More than 10 days before: full refund', 'Inside 10 days: up to 80% refund'],
  },
} as const;

const COPY = {
  private: {
    name: 'Private transfers',
    blurb: 'A car and driver for each journey. Between them, your time is your own.',
    included: 'Air-conditioned car with an English-speaking driver · fuel, tolls and parking · every pickup at your door.',
  },
  chauffeur: {
    name: 'Chauffeur & guide',
    blurb: "The same car and driver stay with you for the whole trip, including the days you're not moving.",
    included: "Vehicle & English-speaking driver for the whole trip · fuel and tolls · driver's meals and accommodation.",
  },
} as const;

function legsOf(quote: ViewQuote): ToolLegLite[] {
  const req = (quote.request ?? {}) as { tool?: { legs?: ToolLegLite[] } };
  return Array.isArray(req.tool?.legs) ? req.tool!.legs! : [];
}

const drives = (l: ToolLegLite) => (l.category || 'transfer') !== 'stay_day';

// The ordered stop list CH_MAP.renderRoute() draws: every stop in sequence, de-duplicated where
// one leg ends where the next begins, so a 5-stop trip renders 5 pins and not 8.
function mapStopsOf(quote: ViewQuote): string[] {
  const out: string[] = [];
  for (const l of legsOf(quote).filter(drives)) {
    const chain = Array.isArray(l.stops) && l.stops.length >= 2 ? l.stops : [l.from ?? '', l.to ?? ''];
    for (const s of chain) {
      if (s && s !== out[out.length - 1]) out.push(s);
    }
  }
  return out;
}

export function customerQuoteView(
  quote: ViewQuote,
  services: { pointToPoint: { totalCents: number } | null; chauffeur: { totalCents: number } | null },
): CustomerQuoteView {
  const copy = payPageCopy(quote);
  const engine = ((quote.request ?? {}) as { engine?: { product?: string } | null }).engine ?? null;
  const priced: 'private' | 'chauffeur' = engine?.product === 'chauffeur' ? 'chauffeur' : 'private';

  // requestedService decides how many options a customer sees (spec D7). Anything other than
  // 'both' — including null on a legacy row — shows the one service that was priced.
  const wantsBoth = quote.requestedService === 'both';
  const other: 'private' | 'chauffeur' = priced === 'private' ? 'chauffeur' : 'private';
  const totalFor = (s: 'private' | 'chauffeur') =>
    (s === 'chauffeur' ? services.chauffeur : services.pointToPoint)?.totalCents ?? null;

  // The priced service always falls back to the STORED total: it is the number that was
  // approved, and a recompute must never quietly outrank it.
  const pricedTotal = totalFor(priced) ?? quote.totalCents;
  const otherTotal = wantsBoth ? totalFor(other) : null;

  const waFor = (label: string | null) =>
    label
      ? `Hi! I'd like to book the ${label} option for quote ${quote.reference}`
      : `Hi! I have a question about quote ${quote.reference}`;

  const build = (service: 'private' | 'chauffeur', cents: number, lead: boolean): QuoteViewOption => {
    const c = COPY[service];
    const diff = lead ? null : cents - pricedTotal;
    return {
      service,
      name: c.name,
      blurb: c.blurb,
      // The priced option reuses payPageCopy's own inclusion sentence, so the quote page and the
      // pay page describe the same purchase in the same words.
      includedText: lead ? copy.includedText : c.included,
      totalCents: cents,
      totalUsd: usd(cents),
      deltaUsd: diff == null || diff <= 0 ? null : `+${usd(diff)}`,
      deltaText:
        diff == null || diff <= 0
          ? null
          : `+${usd(diff)} — ${service === 'chauffeur' ? 'your driver stays with you throughout' : 'you travel journey by journey'}`,
      cancellation: { headline: CANCELLATION[service].headline, ladder: [...CANCELLATION[service].ladder] },
      lead,
      waText: waFor(c.name),
    };
  };

  const options: QuoteViewOption[] = [build(priced, pricedTotal, true)];
  if (otherTotal != null) options.push(build(other, otherTotal, false));

  const driving = legsOf(quote).filter(drives);
  const kms = driving.map((l) => (typeof l.distanceKm === 'number' ? l.distanceKm : 0));
  const totalKm = kms.some((k) => k > 0) ? Math.round(kms.reduce((a, b) => a + b, 0)) : null;

  const secondary = options[1];
  const heroTotalNote = secondary
    ? `${options[0].name.toLowerCase()} · or ${secondary.totalUsd} with your driver throughout`
    : `all-in · ${options[0].name.toLowerCase()}`;

  return {
    reference: quote.reference,
    greetingName: copy.greetingName,
    title: copy.title,
    subtitle: copy.subtitle,
    heroTotalUsd: usd(pricedTotal),
    heroTotalNote,
    days: quoteDays(quote),
    mapStops: mapStopsOf(quote),
    totalKm,
    travelDays: driving.length,
    options,
    waText: waFor(null),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd api && npx vitest run src/quote/customerQuoteView.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
cd api && npm run check
git add api/src/quote/customerQuoteView.ts api/src/quote/customerQuoteView.test.ts
git commit -m "$(cat <<'EOF'
feat: extract the margin-safe customer quote view

One projection for the quote page, the pay page and the parked customer
quote email, so the three surfaces cannot drift in how they describe the
same trip. requestedService decides how many options appear; the second
option carries a delta line so the page does the arithmetic instead of
asking the customer to diff two paragraphs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: The following token

**Files:**
- Modify: `api/src/lib/bookingToken.ts`
- Test: `api/src/lib/bookingToken.test.ts` (create if absent)

**Interfaces:**
- Consumes: existing `macBytes`, `b64url`, `PURPOSE_QUOTE_PAY` in the same file.
- Produces: `signQuoteViewToken(quoteId: string, secret: string): string`; `verifyQuoteViewToken(token: string | undefined, secret: string): { quoteId: string } | null`.

- [ ] **Step 1: Write the failing tests**

Append to `api/src/lib/bookingToken.test.ts` (create the file with the imports below if it does not exist):

```ts
import { describe, it, expect } from 'vitest';
import {
  signQuoteViewToken, verifyQuoteViewToken,
  signQuotePayToken, verifyQuotePayToken,
} from './bookingToken';

const S = 'test-secret';
const ID = '11111111-2222-4333-8444-555555555555';

describe('quote view token', () => {
  it('round-trips the quote id', () => {
    expect(verifyQuoteViewToken(signQuoteViewToken(ID, S), S)).toEqual({ quoteId: ID });
  });

  it('is deterministic, so re-copying a link yields a byte-identical URL', () => {
    expect(signQuoteViewToken(ID, S)).toBe(signQuoteViewToken(ID, S));
  });

  it('rejects a wrong secret and a tampered body', () => {
    const t = signQuoteViewToken(ID, S);
    expect(verifyQuoteViewToken(t, 'other-secret')).toBeNull();
    expect(verifyQuoteViewToken('AAAA' + t.slice(4), S)).toBeNull();
    expect(verifyQuoteViewToken(undefined, S)).toBeNull();
  });

  it('cannot be spent as a pay token, and a pay token cannot be spent as a view token', () => {
    expect(verifyQuotePayToken(signQuoteViewToken(ID, S), S)).toBeNull();
    expect(verifyQuoteViewToken(signQuotePayToken(ID, 3, S, 1), S)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd api && npx vitest run src/lib/bookingToken.test.ts -t "quote view token"
```

Expected: FAIL — `signQuoteViewToken is not a function`.

- [ ] **Step 3: Write the implementation**

In `api/src/lib/bookingToken.ts`, directly below the existing `const PURPOSE_QUOTE_PAY = 0x01;` line add:

```ts
const PURPOSE_QUOTE_VIEW = 0x02; // disjoint from PURPOSE_QUOTE_PAY — see signQuoteViewToken
```

Then, after `verifyQuotePayToken`, append:

```ts
// ── the quote VIEW token (spec 2026-08-05 D3) ────────────────────────────────────────────────
// The quote link FOLLOWS its quote; only the pay token pins. So this token carries NO revision
// and NO seq — following is a property of the type, not a branch in the code, and there is no
// path by which this one could be made to pin. Liveness is read from the quote's status (D8).
//
// Deterministic by construction, which is what makes "copy the link twice, get the same URL"
// free — ops re-pastes the link into the thread rather than making the customer scroll.
//
// Packed: 1 version + 1 purpose + 16 uuid = 18 bytes. The purpose byte is disjoint from the pay
// token's, so neither can be spent as the other even though both are HMACs over the same secret.
export function signQuoteViewToken(quoteId: string, secret: string): string {
  const hex = quoteId.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    return signedBody({ v: 1, purpose: 'quote-view', q: quoteId }, secret);
  }
  const buf = Buffer.alloc(18);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(PURPOSE_QUOTE_VIEW, 1);
  Buffer.from(hex, 'hex').copy(buf, 2);
  const body = b64url(buf);
  return `${body}.${b64url(macBytes(body, secret))}`;
}

export function verifyQuoteViewToken(
  token: string | undefined,
  secret: string,
): { quoteId: string } | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (body && sig) {
    let buf: Buffer | null = null;
    try {
      buf = Buffer.from(body, 'base64url');
    } catch {
      buf = null;
    }
    if (buf && buf.length === 18 && buf.readUInt8(0) === 1 && buf.readUInt8(1) === PURPOSE_QUOTE_VIEW) {
      const expected = b64url(macBytes(body, secret));
      if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        const hex = buf.subarray(2, 18).toString('hex');
        return {
          quoteId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        };
      }
      return null;
    }
  }
  const parsed = verifiedPayload(token, secret) as { v?: unknown; purpose?: unknown; q?: unknown } | null;
  if (!parsed || parsed.v !== 1 || parsed.purpose !== 'quote-view') return null;
  if (typeof parsed.q !== 'string' || parsed.q.length === 0) return null;
  return { quoteId: parsed.q };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd api && npx vitest run src/lib/bookingToken.test.ts -t "quote view token"
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd api && npm run check
git add api/src/lib/bookingToken.ts api/src/lib/bookingToken.test.ts
git commit -m "$(cat <<'EOF'
feat: add a following token for quote links

No revision and no seq, so a quote link cannot pin — following is a
property of the type rather than a branch in the code. Its purpose byte
is disjoint from the pay token's, so neither can be spent as the other.
Deterministic, which is what makes re-copying a link yield the same URL.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The read endpoint

**Files:**
- Create: `api/src/routes/quoteView.ts`
- Test: `api/src/routes/quoteView.test.ts`
- Modify: `api/src/app.ts`

**Interfaces:**
- Consumes: `verifyQuoteViewToken` (Task 4); `customerQuoteView` (Task 3); `SavedQuote.offerValidUntil` (Task 1); existing `serviceChooserData`-equivalent pricing (see Step 3 — the route prices via the exported helper added here).
- Produces: `quoteViewRoutes(deps: { quotes: QuoteRepo; bookings: BookingRepo; linkSecret: string; appBaseUrl?: string; now?: () => number }): Hono` mounted at `/quote-view`.

**Response shape:**

```ts
{ state: 'live' | 'lapsed', view: CustomerQuoteView, validUntil: string | null }
| { state: 'booked', booked: { reference: string | null; firstName: string | null; title: string; manageUrl: string | null } }
| { state: 'unavailable' }
```

- [ ] **Step 1: Write the failing tests**

Create `api/src/routes/quoteView.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { signQuoteViewToken, signQuotePayToken } from '../lib/bookingToken';

const SECRET = 'test-link-secret';

// A ready, priced, two-leg private ops quote — the shape every assertion below builds on.
function quoteInput() {
  return {
    channel: 'ops' as const,
    customerName: 'Anna Bergström',
    customerContact: 'anna@example.com',
    vehicle: 'car',
    currency: 'USD',
    totalCents: 84_000,
    marginCents: 31_000,
    requestedService: 'private',
    request: {
      engine: {
        product: 'private', vehicle: 'car', pax: 2, bags: 2,
        legs: [
          { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
          { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
        ],
        firstDate: '2026-08-20', lastDate: '2026-08-22',
      },
      tool: {
        passengerCount: 2, luggageCount: 2, vehicle: 'car',
        legs: [
          { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
          { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
        ],
      },
    },
    result: { totalCents: 84_000, marginEstimateCents: 31_000, lineItems: [] },
  };
}

describe('GET /quote-view', () => {
  let quotes: InMemoryQuoteRepo;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    quotes = new InMemoryQuoteRepo();
    app = createApp({ quotes, bookingLinkSecret: SECRET });
  });

  async function readyQuote(over: Record<string, unknown> = {}) {
    const saved = await quotes.save(quoteInput() as never);
    return (await quotes.patch(saved.id, { status: 'ready', ...over }))!;
  }

  const get = (t: string) => app.request(`/quote-view?t=${encodeURIComponent(t)}`);

  it('renders a live quote and sends Cache-Control: no-store', async () => {
    const q = await readyQuote();
    const res = await get(signQuoteViewToken(q.id, SECRET));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.state).toBe('live');
    expect(body.view.heroTotalUsd).toBe('$840');
    expect(body.view.options).toHaveLength(1);
  });

  it('never leaks margin', async () => {
    const q = await readyQuote();
    const body = await (await get(signQuoteViewToken(q.id, SECRET))).json();
    const s = JSON.stringify(body);
    expect(s).not.toMatch(/margin/i);
    expect(s).not.toMatch(/rateCard|costPerKm|hotZone/i);
  });

  it('FOLLOWS the quote — an edit does not kill the link', async () => {
    const q = await readyQuote();
    const token = signQuoteViewToken(q.id, SECRET);
    const before = await (await get(token)).json();
    expect(before.view.title).toBeTruthy();

    const edited = { ...quoteInput(), id: q.id, totalCents: 99_000 } as never;
    await quotes.update(edited);
    await quotes.patch(q.id, { status: 'ready' });

    const after = await (await get(token)).json();
    expect(after.state).toBe('live');
    expect(after.view.heroTotalUsd).toBe('$990');
  });

  it('reads as lapsed past offerValidUntil, still returning the itinerary', async () => {
    const q = await readyQuote({ offerValidUntil: new Date('2026-08-01T00:00:00Z') });
    const app2 = createApp({ quotes, bookingLinkSecret: SECRET, now: () => Date.parse('2026-08-20T00:00:00Z') });
    const res = await app2.request(`/quote-view?t=${signQuoteViewToken(q.id, SECRET)}`);
    const body = await res.json();
    expect(body.state).toBe('lapsed');
    expect(body.view.days.length).toBeGreaterThan(0);
    expect(body.validUntil).toContain('2026-08-01');
  });

  it('is unavailable for draft, lost and soft-deleted quotes', async () => {
    for (const status of ['draft', 'lost'] as const) {
      const q = await readyQuote();
      await quotes.patch(q.id, { status });
      expect((await (await get(signQuoteViewToken(q.id, SECRET))).json()).state).toBe('unavailable');
    }
    const gone = await readyQuote();
    await quotes.softDelete(gone.id, 'ops@ceylonhop.com');
    expect((await (await get(signQuoteViewToken(gone.id, SECRET))).json()).state).toBe('unavailable');
  });

  it('answers a soft 200 unavailable for a bad or foreign token — never a 404 probe', async () => {
    for (const t of ['nonsense', signQuoteViewToken('11111111-2222-4333-8444-555555555555', SECRET)]) {
      const res = await get(t);
      expect(res.status).toBe(200);
      expect((await res.json()).state).toBe('unavailable');
    }
  });

  it('refuses a pay token', async () => {
    const q = await readyQuote();
    const body = await (await get(signQuotePayToken(q.id, q.revision, SECRET, 0))).json();
    expect(body.state).toBe('unavailable');
  });

  it('shows the keepsake for a won quote', async () => {
    const q = await readyQuote();
    await quotes.patch(q.id, { status: 'sent' });
    await quotes.patch(q.id, { status: 'won' });
    const body = await (await get(signQuoteViewToken(q.id, SECRET))).json();
    expect(body.state).toBe('booked');
    expect(body.booked.firstName).toBe('Anna');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd api && npx vitest run src/routes/quoteView.test.ts
```

Expected: FAIL — the `/quote-view` route 404s.

- [ ] **Step 3: Write the route**

Create `api/src/routes/quoteView.ts`:

```ts
import { Hono } from 'hono';
import type { QuoteRepo, SavedQuote } from '../db/quoteRepo';
import type { BookingRepo } from '../db/bookingRepo';
import { verifyQuoteViewToken, signBookingToken } from '../lib/bookingToken';
import { customerQuoteView } from '../quote/customerQuoteView';
import { rateCardFor } from '../quote/rateLock';
import { quote as priceQuote } from '../quote/engine';
import type { QuoteRequest } from '../quote/types';

// The customer half of quote links (spec 2026-08-05). ONE route, and it READS — this module has
// no POST and touches no repo mutation, which is what makes a forwarded quote link harmless.
// Two invariants dominate the file:
//
//   1. MARGIN NEVER REACHES THE WIRE. The stored quote carries marginCents, the locked rate card
//      (cost + markup) and hot-zone annotations. The response is built from customerQuoteView's
//      hand-picked projection; `result`, `request` and `rateCardJson` are never echoed.
//
//   2. THE LINK FOLLOWS THE QUOTE. The token pins nothing, so an edit updates this page rather
//      than killing it. Liveness comes from the quote's STATUS (D8), which also gives ops an
//      instant kill switch a timer could not.

type ViewState = 'live' | 'lapsed' | 'booked' | 'unavailable';

// Both services, priced against the card this quote is LOCKED to — the same inputs the ops
// service chooser uses, so the customer can never be shown a number ops has not seen. Any
// failure degrades to "not offerable" rather than 500ing in front of a customer.
function servicesFor(quote: SavedQuote, now: Date): {
  pointToPoint: { totalCents: number } | null;
  chauffeur: { totalCents: number } | null;
} {
  const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
  if (!engine) return { pointToPoint: null, chauffeur: null };
  let card;
  try {
    ({ rateCard: card } = rateCardFor(
      { rateCardJson: (quote.rateCardJson ?? null) as never, rateLockedUntil: quote.rateLockedUntil },
      now,
    ));
  } catch {
    return { pointToPoint: null, chauffeur: null };
  }
  const price = (product: 'private' | 'chauffeur') => {
    try {
      return { totalCents: priceQuote({ ...engine, product }, card).totalCents };
    } catch {
      return null;
    }
  };
  // Chauffeur needs a dated, multi-day itinerary; single-day and undated trips are
  // point-to-point only, and the page then renders one card rather than a hole.
  const dates = new Set((engine.legs ?? []).map((l) => (l as { date?: string }).date).filter(Boolean));
  return {
    pointToPoint: price('private'),
    chauffeur: dates.size > 1 ? price('chauffeur') : null,
  };
}

export function quoteViewRoutes(deps: {
  quotes: QuoteRepo;
  bookings?: BookingRepo;
  linkSecret: string;
  appBaseUrl?: string;
  now?: () => number;
}) {
  const r = new Hono();
  const nowMs = deps.now ?? (() => Date.now());

  r.get('/', async (c) => {
    // Every answer is 200 + no-store. A following link whose response is cached anywhere is a
    // pinned link with extra steps — the exact behaviour this design exists to avoid, failing in
    // the way hardest to notice because it works for whoever tests it first.
    const send = (body: Record<string, unknown>) => c.json(body, 200, { 'cache-control': 'no-store' });

    const parsed = verifyQuoteViewToken(c.req.query('t'), deps.linkSecret);
    if (!parsed) return send({ state: 'unavailable' as ViewState }); // soft — no detail leak
    const quote = await deps.quotes.get(parsed.quoteId);
    if (!quote) return send({ state: 'unavailable' as ViewState });

    const now = new Date(nowMs());

    // Won FIRST: a quote that succeeded must never read as a dead end.
    if (quote.status === 'won') {
      const booking = quote.convertedBookingId && deps.bookings
        ? await deps.bookings.get(quote.convertedBookingId)
        : null;
      return send({
        state: 'booked' as ViewState,
        booked: {
          reference: booking?.reference ?? null,
          firstName: (quote.customerName ?? '').trim().split(/\s+/)[0] || null,
          title: customerQuoteView(quote, servicesFor(quote, now)).title,
          // The keepsake hands the customer to where their booking actually lives.
          manageUrl: booking && deps.appBaseUrl
            ? `${deps.appBaseUrl.replace(/\/$/, '')}/manage.html?t=${signBookingToken(booking.id, deps.linkSecret)}`
            : null,
        },
      });
    }

    if (quote.status !== 'ready' && quote.status !== 'sent') {
      return send({ state: 'unavailable' as ViewState });
    }

    const lapsed = !!quote.offerValidUntil && quote.offerValidUntil.getTime() < now.getTime();
    return send({
      state: (lapsed ? 'lapsed' : 'live') as ViewState,
      view: customerQuoteView(quote, servicesFor(quote, now)),
      validUntil: quote.offerValidUntil ? quote.offerValidUntil.toISOString() : null,
    });
  });

  return r;
}
```

**Read `api/src/quote/engine.ts` and `api/src/quote/rateLock.ts` before writing this file** and match the real export names and argument order. If the engine's entry point is not `quote(request, card)`, use whatever `internalQuote.ts`'s `serviceChooserData` calls — that function is the reference implementation for pricing both services against the locked card.

- [ ] **Step 4: Mount it**

In `api/src/app.ts`, immediately **before** the `app.route('/', customerPagesRoutes({...}))` line, add:

```ts
  // The customer quote page's read endpoint. Public and token-keyed like /quote-pay, but it
  // READS ONLY — no route in it can start a payment (spec D6).
  app.route('/quote-view', quoteViewRoutes({
    quotes, bookings, linkSecret: bookingLinkSecret, appBaseUrl: payBaseUrl,
  }));
```

Add the import at the top beside the other route imports:

```ts
import { quoteViewRoutes } from './routes/quoteView';
```

If `createApp`'s deps do not already accept `now?: () => number`, add it to the deps interface and thread it into `quoteViewRoutes({ ..., now: deps.now })` — the lapsed test needs a controllable clock.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd api && npx vitest run src/routes/quoteView.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
cd api && npm run check
git add api/src/routes/quoteView.ts api/src/routes/quoteView.test.ts api/src/app.ts
git commit -m "$(cat <<'EOF'
feat: serve the customer quote view

One read-only endpoint, no POST, no repo mutation — a forwarded quote
link can reach nothing that writes or charges. Responses are no-store,
because a cached following link is a pinned link with extra steps.
Liveness comes from the quote's status, so ops can kill a link instantly
by moving it out of ready/sent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Minting, validity stamping, and the ops button

**Files:**
- Modify: `api/src/config.ts`, `api/src/app.ts`, `api/src/routes/internalQuote.ts`, `api/src/routes/ops-ui.html`
- Test: `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `signQuoteViewToken` (Task 4); `QuotePatch.offerValidUntil` (Task 1).
- Produces: `POST /admin/quote/:id/quote-link` → `{ url: string }`; `offerValidUntil` stamped on `→ ready`.

- [ ] **Step 1: Write the failing tests**

Append to `api/src/routes/internalQuote.test.ts` (match the file's existing app/auth harness — read its top before writing):

```ts
describe('quote links', () => {
  it('mints a stable URL for a ready quote', async () => {
    const q = await readyOpsQuote();
    const a = await post(`/admin/quote/${q.id}/quote-link`);
    const b = await post(`/admin/quote/${q.id}/quote-link`);
    expect(a.status).toBe(200);
    const urlA = (await a.json()).url as string;
    expect(urlA).toMatch(/\/q\?t=/);
    expect((await b.json()).url).toBe(urlA); // byte-identical on re-copy
  });

  it('refuses a draft quote', async () => {
    const q = await draftOpsQuote();
    const res = await post(`/admin/quote/${q.id}/quote-link`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_linkable');
  });

  it('stamps offerValidUntil seven days out when a quote is approved', async () => {
    const q = await pendingReviewOpsQuote();
    await patch(`/admin/quote/${q.id}`, { status: 'ready' });
    const after = await quotes.get(q.id);
    const days = (after!.offerValidUntil!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts -t "quote links"
```

Expected: FAIL — the mint route 404s.

- [ ] **Step 3: Add the config value**

In `api/src/config.ts`, beside `PAY_BASE_URL`, add:

```ts
  // Where customer QUOTE links point (spec 2026-08-05 D2) — e.g. https://quote.ceylonhop.com.
  // A second custom domain on THIS service, so the page it serves is same-origin with the API.
  // Unset falls back to PAY_BASE_URL, which keeps dev and staging working with one host.
  QUOTE_BASE_URL: z.string().default(''),
```

In `api/src/app.ts`, beside the existing `payBaseUrl` resolution, add:

```ts
  const quoteBaseUrl = deps.quoteBaseUrl ?? (config.QUOTE_BASE_URL || undefined) ?? payBaseUrl;
```

Add `quoteBaseUrl?: string;` to `createApp`'s deps interface, and pass `quoteBaseUrl` into `internalQuoteRoutes({ ... })`.

- [ ] **Step 4: Add the mint route**

In `api/src/routes/internalQuote.ts`, add `quoteBaseUrl?: string;` to the deps interface beside `payBaseUrl`, import `signQuoteViewToken` from `../lib/bookingToken`, and add this route immediately after the existing `r.post('/:id/pay-link', ...)` handler:

```ts
  // The customer quote link (spec 2026-08-05). Same gate as the pay link — an approved quote —
  // but it mints no state: the token pins nothing, so pressing this twice is byte-identical and
  // ops can re-paste the link into the thread instead of making the customer scroll.
  r.post('/:id/quote-link', csrf, async (c) => {
    const quote = await deps.quotes.get(c.req.param('id'));
    if (!quote) return c.json({ error: 'not_found' }, 404);
    if (quote.channel !== 'ops' || (quote.status !== 'ready' && quote.status !== 'sent')) {
      return c.json({ error: 'not_linkable', status: quote.status }, 409);
    }
    const base = deps.quoteBaseUrl || deps.payBaseUrl;
    if (!deps.linkSecret || !base) return c.json({ error: 'quote_links_unavailable' }, 503);

    // Same price-drift baseline the pay link stamps, for the same reason: minting is a
    // customer-facing moment, and with a FOLLOWING link the number can move under a customer
    // who has already looked.
    if (quote.customerTotalCents !== quote.totalCents) {
      await deps.quotes.patch(quote.id, {
        customerTotal: { cents: quote.totalCents, at: new Date(), via: 'quote_link' as const },
      });
    }
    return c.json({ url: `${base.replace(/\/$/, '')}/q?t=${signQuoteViewToken(quote.id, deps.linkSecret)}` });
  });
```

If the `customerTotal` patch shape rejects `'quote_link'`, widen the `via` union in `api/src/db/quoteRepo.ts` to include it — read the existing type before editing.

- [ ] **Step 5: Stamp the validity date on approval**

In `api/src/routes/internalQuote.ts`, inside the `PATCH /:id` status handler, find the block that applies the rate lock on the transition into `ready` (search for `rateLock = { rateCardJson: await liveCard(), rateLockedUntil: null }`). Immediately after it add:

```ts
      // Offer validity (spec D9): the price is honoured for 7 days from approval. Re-approving
      // resets it, so the fix for a lapsed quote is the thing ops was going to do anyway.
      // Deliberately NOT rateLockedUntil, which stays null for ops quotes — that is precisely
      // why this field exists.
      offerValidUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000);
```

and include `offerValidUntil` in the object handed to `deps.quotes.patch(...)` for that transition. Declare `let offerValidUntil: Date | undefined;` beside the existing `rateLock` declaration.

- [ ] **Step 6: Add the ops button**

In `api/src/routes/ops-ui.html`, find `mintPayLink()` and add beside it:

```js
/* The customer QUOTE link (spec 2026-08-05). Unlike the pay link this mints no state, so the
   button is a plain mint-and-copy with no picker and no sandbox warning — a quote link takes
   no money and cannot reach anything that does. */
async function copyQuoteLink() {
  if (!state.savedId) return;
  try {
    var r = await api('/admin/quote/' + encodeURIComponent(state.savedId) + '/quote-link', { method: 'POST' });
    if (!r.ok) {
      var err = await jsonOrNull(r);
      showToast(err && err.error === 'not_linkable'
        ? 'Only an approved (ready or sent) quote can have a quote link'
        : 'Could not create the quote link', 'error');
      return;
    }
    var body = await jsonOrNull(r);
    if (!body || !body.url) { showToast('Could not create the quote link', 'error'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(body.url).catch(function () {});
    }
    showToast('Quote link copied');
  } catch (e) {
    window.opsReportError && window.opsReportError('mint quote link', e);
    showToast('Could not create the quote link', 'error');
  }
}
```

Then find the markup that renders the "Payment link" button and add a sibling button immediately before it with `data-action="copyQuoteLink"`, label `Quote link`, using the same `class` as the payment-link button. Wire `case 'copyQuoteLink': copyQuoteLink(); break;` into the same click-delegation switch that handles the payment-link action.

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd api && npx vitest run src/routes/internalQuote.test.ts -t "quote links"
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```bash
cd api && npm run check
git add api/src/config.ts api/src/app.ts api/src/routes/internalQuote.ts api/src/routes/ops-ui.html api/src/routes/internalQuote.test.ts
git commit -m "$(cat <<'EOF'
feat: mint customer quote links from ops

One press mints and copies, and pressing it twice yields the same URL —
the property ops relies on to re-paste a link already sent. Approval now
stamps a 7-day offer validity, which is what the page's "held until" date
reads from. Falls back to PAY_BASE_URL when QUOTE_BASE_URL is unset so
dev and staging keep working on one host.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: The page

**Files:**
- Create: `quote.html`, `quote.css` (repo root, beside `pay.html`)
- Modify: `api/src/routes/customerPages.ts`
- Test: `api/src/routes/customerPages.test.ts`

**Interfaces:**
- Consumes: `GET /quote-view` (Task 5) response shape.
- Produces: `GET /q` and `GET /quote.html` serving the page; `quote.css` and `ch-map.js` in the served asset list.

**Reference:** build the markup and CSS from `docs/prototypes/customer-quote-page.html` — it is the approved design and uses the real `ticket.css` class names. Copy its `.pg`-scoped rules into `quote.css`, dropping the `.pg` prefix and the prototype's dark chrome.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/customerPages.test.ts`:

```ts
it('serves the quote page at /q and /quote.html with the API origin injected', async () => {
  for (const path of ['/q', '/quote.html']) {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('window.CEYLON_HOP_API=location.origin');
    expect(html).toContain('quote.css');
  }
});

it('serves quote.css and ch-map.js', async () => {
  expect((await app.request('/quote.css')).status).toBe(200);
  expect((await app.request('/ch-map.js')).status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && npx vitest run src/routes/customerPages.test.ts -t "quote page"
```

Expected: FAIL — 404.

- [ ] **Step 3: Register the page and its assets**

In `api/src/routes/customerPages.ts`:

1. Change `const PAGES = ['manage.html', 'pay.html'];` to `const PAGES = ['manage.html', 'pay.html', 'quote.html'];`
2. Add to `ASSETS`:

```ts
  ['quote.css', 'text/css; charset=utf-8'],
  ['ch-map.js', JS], // the shared route renderer, same file booking.js and plan.js use
```

3. Change the page loop so `/q` aliases `quote.html` the way `/p` aliases `pay.html`:

```ts
  for (const page of [...PAGES, 'p', 'q']) {
    const file = page === 'p' ? 'pay.html' : page === 'q' ? 'quote.html' : page;
```

The existing `if (file !== 'pay.html') return c.html(html);` line already means the quote page serves without OG injection — leave it; the quote share card is a follow-up.

- [ ] **Step 4: Write the page**

Create `quote.css` by lifting every `.pg`-scoped rule from `docs/prototypes/customer-quote-page.html` (strip the `.pg ` prefix, keep the comments explaining *why* each choice was made), plus:

```css
/* Option columns switch on the COLUMN's width, not the viewport's. A viewport media query
   here fired inside narrow embeds and crushed both cards into half a phone. */
.pp-wrap{container-type:inline-size}
@container (min-width:560px){.opts.two{grid-template-columns:1fr 1fr;align-items:start}}
```

Create `quote.html` modelled on `pay.html`'s structure — same `<head>`, `site.css` + `ticket.css` + `quote.css`, same brand header markup, and a `<div id="app">` the script fills. The script must:

```js
// Same contract as pay.html: window.CEYLON_HOP_API is injected by customerPages when the API
// host serves this file; the hard-coded default is the fallback for the customer site.
var API = window.CEYLON_HOP_API || 'https://api.ceylonhop.com';
var WA = '94779669662';
var token = new URLSearchParams(location.search).get('t') || '';

function waHref(text){ return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(text); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(m){
  return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]; }); }

// First paint is the page's own shape, not a bare line of text — ticket.css grew .tk-sk
// because pay.html's unskeletoned first paint jumped, and this page is heavier.
function renderSkeleton(){ /* .tk-sk blocks: hero lines, map block, one option card */ }

function renderLive(d, lapsed){ /* hero + held-until + map + options + days, per the prototype */ }
function renderBooked(d){ /* .st-wrap keepsake + "View your booking" when manageUrl is present */ }
function renderUnavailable(){ /* the "sailed off somewhere sunny" screen, copied from pay.html */ }

// The map is DEFERRED until it scrolls into view: ch-map.js memoises per page load, so every
// open bills a computeRoutes call, and this page is designed to be opened repeatedly.
function mountMap(stops){
  var host = document.getElementById('map');
  if (!host || !window.CH_MAP || stops.length < 2) return;
  var io = new IntersectionObserver(function(entries){
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    window.CH_MAP.renderRoute(host, stops, {});
  }, { rootMargin: '200px' });
  io.observe(host);
}
```

Every option card's CTA is `<a class="btn btn-wa pp-cta" href="waHref(option.waText)">` — the prefill is how the customer's choice reaches ops. The lead option uses `.btn-wa`; any second option uses `.btn-ghost`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd api && npx vitest run src/routes/customerPages.test.ts -t "quote"
```

Expected: PASS.

- [ ] **Step 6: Verify it in the browser**

Start the dev server via the Browser pane's `preview_start` (never `npm run dev` in Bash), open `/q?t=<a token minted from a seeded ready quote>`, and confirm with `read_console_messages` (no errors), `read_page` (hero total, day rows, option card present) and a screenshot at a 375px viewport.

- [ ] **Step 7: Commit**

```bash
git add quote.html quote.css api/src/routes/customerPages.ts api/src/routes/customerPages.test.ts
git commit -m "$(cat <<'EOF'
feat: add the customer quote page

Read-only proposal at /q — hero total, route map, both service options
when the customer asked for both, and the itinerary day by day. Every
action is a wa.me link carrying the quote reference and the tapped
option, so the customer's choice reaches ops without a round-trip and
nothing on the page can start a payment.

The map is deferred until it scrolls into view: ch-map.js memoises per
page load, so every open would otherwise bill a route computation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: End-to-end coverage

**Files:**
- Create: `web-tests/e2e/quote-page.spec.js`
- Test: itself

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the failing spec**

Create `web-tests/e2e/quote-page.spec.js`, matching the harness the neighbouring specs use (read `web-tests/e2e/_stubs.js` and one existing spec first — the API base and seeding helpers must match exactly):

```js
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 } });

test('a live quote link shows the price, the itinerary and a WhatsApp CTA', async ({ page }) => {
  const url = await mintQuoteLink(page); // seed a ready quote + POST /admin/quote/:id/quote-link
  await page.goto(url);

  await expect(page.locator('.hero-tot .v')).toHaveText(/^\$\d/);
  await expect(page.locator('.hop')).not.toHaveCount(0);
  const cta = page.locator('a.btn-wa').first();
  await expect(cta).toHaveAttribute('href', /wa\.me\/94779669662\?text=/);
  await expect(cta).toHaveAttribute('href', /Q-|quote%20/i);
});

test('option cards stack on a phone', async ({ page }) => {
  const url = await mintBothQuoteLink(page);
  await page.goto(url);
  const cards = page.locator('.opts .ticket');
  await expect(cards).toHaveCount(2);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(b.y).toBeGreaterThan(a.y + a.height - 5); // stacked, not side by side
  expect(Math.abs(a.width - b.width)).toBeLessThan(2);
});

test('no pay button exists anywhere on the page', async ({ page }) => {
  const url = await mintQuoteLink(page);
  await page.goto(url);
  await expect(page.getByRole('button', { name: /pay/i })).toHaveCount(0);
  await expect(page.locator('a[href*="/p?t="]')).toHaveCount(0);
});
```

Implement `mintQuoteLink` / `mintBothQuoteLink` as local helpers in the spec using the same seeding approach the existing e2e specs use.

- [ ] **Step 2: Run to verify it fails, then passes**

```bash
cd web-tests && npm run test:all
```

Expected: initially FAIL on the new spec; PASS once the helpers seed correctly. Per the repo's e2e lesson, **act then verify** — assert against state after the action, never the state racing it.

If `CH_E2E_API` specs fail with "#login not found", a foreign server owns port 8787 — kill it before concluding anything is broken.

- [ ] **Step 3: Commit**

```bash
git add web-tests/e2e/quote-page.spec.js
git commit -m "$(cat <<'EOF'
test: cover the quote page end to end

Asserts the price renders, the itinerary renders, CTAs carry the quote
reference into WhatsApp, cards stack on a phone, and no pay button
exists anywhere on the page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Deploy prerequisites

**Files:**
- Modify: `docs/go-live-checklist.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

These are **operator actions**, not code. The build is not shippable without them.

- [ ] **Step 1: Record them in the checklist**

Append to `docs/go-live-checklist.md`:

```markdown
### Customer quote links (spec 2026-08-05)

- [ ] **`quote.ceylonhop.com` added as a custom domain on the API service** (same service as
      `pay.ceylonhop.com` — not a second deployment). Verify the certificate issues before
      minting any link against it.
- [ ] **`quote.ceylonhop.com` added to the Google Maps browser-key referrer allow-list.**
      Miss this and the route map silently falls back to the placeholder with no error — the
      same trap as 127.0.0.1.
- [ ] **`QUOTE_BASE_URL` set** on the API service (`https://quote.ceylonhop.com`). Unset, the
      mint falls back to `PAY_BASE_URL`, so quote links would be sent from the pay domain.
- [ ] **A muted Google map style applied** (cloud style ID: desaturated terrain, POI labels
      off). Default tiles fight the page's cream-and-teal design.
```

- [ ] **Step 2: Commit**

```bash
git add docs/go-live-checklist.md
git commit -m "$(cat <<'EOF'
docs: record the quote-link deploy prerequisites

The Maps referrer entry is the one that fails silently — without it the
route map falls back to the placeholder and nothing reports an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:** D1 (separate page) → Task 7. D2 (hostname, same service) → Tasks 6, 9. D3 (following token) → Task 4. D4 (stable mint) → Task 6 Step 1. D5/D6 (read-only, no pay path) → Tasks 5, 7, 8 Step 1. D7 (`requestedService`) → Task 3. D8 (status liveness) → Task 5. D9 (7-day validity) → Tasks 1, 6. D10 (shared projection) → Task 3. D11 (share card) → deliberately **out of this plan**; the quote page serves without OG injection and the card is a follow-up, matching the spec's §11 note that the 28 Jul prototype stays live. D12 (map/days/options) → Tasks 2, 3, 7. D13 (no perforation) → Task 7's prototype reference. §4.3 caching → Task 5. §4.4 map cost → Task 7 (deferred render); the **server-side route cache is deferred** — deferral plus the IntersectionObserver keeps first-cut cost bounded, and a shared cache is worth building once real traffic shows the hit rate.

**Known follow-ups this plan does not build:** the quote share card (OG unfurl), the server-side route cache, wiring `sendCustomerQuote` to send, and an ops-authored per-day description.
