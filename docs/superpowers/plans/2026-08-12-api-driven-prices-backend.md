# API-Driven Prices — Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend able to price a customer trip from place names alone, with hot zones applied, without changing any price the website currently shows.

**Architecture:** Lift the existing ops rate-card-plus-zones composition into a shared helper, feed it to the public quote and booking routes, add a non-persisting `/quote/v2/estimate` endpoint, and let the engine return a price built on an estimated distance rather than refusing. No front-end pricing changes in this plan.

**Tech Stack:** Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres · npm.

## Global Constraints

- Backend code lives in `api/`. Run `cd api && npm run check` before every commit; never commit red.
- Money is integer minor units (cents) + ISO currency. IDs are uuid.
- **No new hot-zone logic anywhere.** The engine already owns matching (`hotZones.ts`) and the boost (`private.ts:51`). Populating `rateCard.hotZones` is the entire mechanism.
- **This plan must not move any price.** With zero active zones every total stays byte-identical. `goldens.test.ts` is the guard — if it goes red, the change is wrong.
- Do **not** add fields to `QuoteResult`. `goldens.test.ts` asserts an undiscounted result is byte-identical; new response data belongs at the route layer.
- No real external services. Tests use `FakeMapsAdapter` and `InMemoryZonesRepo`.
- One logical change per commit. Stage by path — never `git add -A` (the working tree is shared with other sessions).

---

### Task 0: Measure the current mismatch rate

**Files:** none — this is a read-only production check.

**Interfaces:**
- Produces: a figure quoted in the PR description of Task 1 ("`price mismatch` fired N times in the last 30 days, max delta $X").

- [ ] **Step 1: Search production logs**

Search Render logs for `ceylon-hop-api` for the string `price mismatch`, emitted by `api/src/routes/bookings.ts:246` and `:514`. Record: number of occurrences in the last 30 days, and the largest `site quoted X¢, engine priced Y¢` gap.

- [ ] **Step 2: Record the finding**

Write the figure into `docs/superpowers/specs/2026-08-12-engine-driven-prices-design.md` under "Step 0", replacing the sentence "The justification for this work is currently **unmeasured**."

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-12-engine-driven-prices-design.md
git commit -m "docs(pricing): record measured price-mismatch baseline"
```

---

### Task 1: Shared live-rate-card helper

**Files:**
- Create: `api/src/quote/liveCard.ts`
- Create: `api/src/quote/liveCard.test.ts`
- Modify: `api/src/routes/internalQuote.ts:670-672`

**Interfaces:**
- Produces: `liveRateCard(zones: ZonesRepo, base?: RateCard): Promise<RateCard>` — the compiled card with the currently-active hot zones attached.

- [ ] **Step 1: Write the failing test**

Create `api/src/quote/liveCard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { liveRateCard } from './liveCard';
import { InMemoryZonesRepo, type NewZone } from '../db/zonesRepo';
import { RATE_CARD } from './rateCard';

// InMemoryZonesRepo takes no constructor seed — rows go in via create().
async function zonesWith(...seed: NewZone[]): Promise<InMemoryZonesRepo> {
  const repo = new InMemoryZonesRepo();
  for (const z of seed) await repo.create(z);
  return repo;
}

describe('liveRateCard', () => {
  it('attaches the active zones to the compiled card', async () => {
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }));
    expect(card.hotZones).toHaveLength(1);
    expect(card.hotZones![0].placeName).toBe('Ella');
    expect(card.hotZones![0].boostPct).toBe(15);
    expect(card.version).toBe(RATE_CARD.version);
  });

  it('yields an empty zone list when none are active', async () => {
    const card = await liveRateCard(new InMemoryZonesRepo());
    expect(card.hotZones).toEqual([]);
  });

  it('omits an inactive zone', async () => {
    const card = await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15, active: false }));
    expect(card.hotZones).toEqual([]);
  });

  it('does not mutate the compiled card', async () => {
    await liveRateCard(await zonesWith({ placeName: 'Ella', boostPct: 15 }));
    expect(RATE_CARD.hotZones).toBeUndefined();
  });
});
```

`activeZones()` maps rows through `toHotZone`, which keeps only the fields the matcher needs — assert on individual fields as above rather than deep-equalling the whole object.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/quote/liveCard.test.ts`
Expected: FAIL — `Cannot find module './liveCard'`.

- [ ] **Step 3: Write the implementation**

Create `api/src/quote/liveCard.ts`:

```ts
import { RATE_CARD, type RateCard } from './rateCard';
import type { ZonesRepo } from '../db/zonesRepo';

// The live rate card composed with the currently-active hot zones (hot-zones spec D5). Built per
// request so a founder zone edit is reflected on the next quote. Zero active zones (or
// HOT_ZONES_DISABLED) => hotZones is [] => pricing identical to pre-hot-zones.
//
// This is the ONLY place a customer-facing or ops price acquires its zone list. The engine does the
// matching and the boost; nothing else composes a card by hand.
export async function liveRateCard(zones: ZonesRepo, base: RateCard = RATE_CARD): Promise<RateCard> {
  return { ...base, hotZones: await zones.activeZones() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && npx vitest run src/quote/liveCard.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Replace the inline copy in internalQuote.ts**

In `api/src/routes/internalQuote.ts`, delete the inline closure at line 672:

```ts
const liveCard = async (): Promise<RateCard> => ({ ...RATE_CARD, hotZones: await zonesRepo.activeZones() });
```

and replace with:

```ts
const liveCard = (): Promise<RateCard> => liveRateCard(zonesRepo);
```

Add the import at the top of the file:

```ts
import { liveRateCard } from '../quote/liveCard';
```

- [ ] **Step 6: Run the ops quote suite**

Run: `cd api && npx vitest run src/routes/internalQuote.test.ts`
Expected: PASS — no behaviour change, the composition is identical.

- [ ] **Step 7: Full check and commit**

```bash
cd api && npm run check
git add api/src/quote/liveCard.ts api/src/quote/liveCard.test.ts api/src/routes/internalQuote.ts
git commit -m "refactor(pricing): extract the live rate-card composition into one helper"
```

---

### Task 2: Zones reach the public quote routes

**Files:**
- Modify: `api/src/routes/quote.ts` (deps type, `/`, `/lock`, `/v2/lock`)
- Modify: `api/src/app.ts:377`
- Test: `api/src/routes/quote.test.ts`

**Interfaces:**
- Consumes: `liveRateCard(zones, base?)` from Task 1.
- Produces: `quoteRoutes({ zones?: ZonesRepo, ... })` — when a repo is supplied, all three quote endpoints price against the zone-composed card.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/quote.test.ts`:

```ts
describe('public quotes apply active hot zones', () => {
  const ZONE_LEG = {
    product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Ella', to: 'Yala', distanceKm: 126 }],
  };

  it('prices an Ella leg higher when an Ella zone is active', async () => {
    const plain = createApp({ quotes: new InMemoryQuoteRepo() });
    const boosted = createApp({
      quotes: new InMemoryQuoteRepo(),
      zones: await zonesWith({ placeName: 'Ella', boostPct: 15 }),
    });
    const a = await (await post(plain, ZONE_LEG)).json();
    const b = await (await post(boosted, ZONE_LEG)).json();
    expect(b.totalCents).toBeGreaterThan(a.totalCents);
  });

  it('leaves a non-zone leg untouched', async () => {
    const plain = createApp({ quotes: new InMemoryQuoteRepo() });
    const boosted = createApp({
      quotes: new InMemoryQuoteRepo(),
      zones: await zonesWith({ placeName: 'Ella', boostPct: 15 }),
    });
    const a = await (await post(plain, PRIVATE_LEG)).json();
    const b = await (await post(boosted, PRIVATE_LEG)).json();
    expect(b.totalCents).toBe(a.totalCents);
  });

  it('freezes the zone into a locked quote snapshot', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({
      quotes,
      zones: await zonesWith({ placeName: 'Ella', boostPct: 15 }),
    });
    const res = await postLock(app, ZONE_LEG);
    expect(res.status).toBe(201);
    const saved = await quotes.get((await res.json()).quoteId);
    expect(saved!.rateCardJson!.hotZones).toEqual([{ placeName: 'Ella', boostPct: 15, active: true }]);
  });
});
```

Add to the imports at the top of the file, plus the same `zonesWith` helper defined in Task 1 (copy it — `InMemoryZonesRepo` has no constructor seed):

```ts
import { InMemoryZonesRepo, type NewZone } from '../db/zonesRepo';

async function zonesWith(...seed: NewZone[]): Promise<InMemoryZonesRepo> {
  const repo = new InMemoryZonesRepo();
  for (const z of seed) await repo.create(z);
  return repo;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/quote.test.ts -t "apply active hot zones"`
Expected: FAIL — the boosted total equals the plain total, and `rateCardJson.hotZones` is undefined.

- [ ] **Step 3: Thread the repo through the route factory**

In `api/src/routes/quote.ts`, add to the `quoteRoutes` deps type:

```ts
zones?: ZonesRepo;
```

with imports:

```ts
import { InMemoryZonesRepo, type ZonesRepo } from '../db/zonesRepo';
import { liveRateCard } from '../quote/liveCard';
```

and immediately inside `quoteRoutes`, before `const r = new Hono()`:

```ts
// No repo injected => an empty in-memory one => zero active zones => pricing identical to today.
const zonesRepo = deps.zones ?? new InMemoryZonesRepo();
const liveCard = (): Promise<RateCard> => liveRateCard(zonesRepo);
```

- [ ] **Step 4: Use the composed card in all three handlers**

In `POST /` replace `const result = quote(parsed.data as QuoteRequest);` with:

```ts
const result = quote(parsed.data as QuoteRequest, await liveCard());
```

In `POST /lock` replace `const result = quote(req);` with:

```ts
const card = await liveCard();
const result = quote(req, card);
```

and in the same handler's `quotes.save({...})` call replace `rateCardJson: RATE_CARD` with `rateCardJson: card`, and `rateCardVersion: RATE_CARD.version` with `rateCardVersion: card.version`.

In `POST /v2/lock` replace `const result = quote(engineRequest);` with:

```ts
const card = await liveCard();
const result = quote(engineRequest, card);
```

and make the same two `rateCardJson` / `rateCardVersion` substitutions in its `quotes.save({...})` call.

- [ ] **Step 5: Wire the repo in app.ts**

In `api/src/app.ts:377`, add `zones,` to the `quoteRoutes({...})` argument object. The `zones` binding already exists at `:158`.

- [ ] **Step 6: Run the tests**

Run: `cd api && npx vitest run src/routes/quote.test.ts`
Expected: PASS — including the three new tests and every pre-existing one.

- [ ] **Step 7: Prove no price moved**

Run: `cd api && npx vitest run src/quote/goldens.test.ts`
Expected: PASS. If this fails, a price moved with zero active zones — stop and diagnose before continuing.

- [ ] **Step 8: Full check and commit**

```bash
cd api && npm run check
git add api/src/routes/quote.ts api/src/routes/quote.test.ts api/src/app.ts
git commit -m "feat(pricing): apply active hot zones to public quotes"
```

---

### Task 3: Zones reach the booking re-price

**Files:**
- Modify: `api/src/routes/bookings.ts:216-226`
- Modify: `api/src/app.ts:328`
- Test: `api/src/routes/bookings.test.ts`

**Interfaces:**
- Consumes: `liveRateCard(zones, base?)` from Task 1.
- Produces: `bookingRoutes({ zones?: ZonesRepo, ... })` — the server-side re-price applies active zones, while a valid rate-locked quote keeps its frozen snapshot.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/bookings.test.ts`:

```ts
describe('booking re-price applies active hot zones', () => {
  it('charges the boosted price for a zone-touching trip', async () => {
    const plain = createApp({ bookings: new InMemoryBookingRepo() });
    const boosted = createApp({
      bookings: new InMemoryBookingRepo(),
      zones: await zonesWith({ placeName: 'Ella', boostPct: 15 }),
    });
    const body = {
      mode: 'single', from: 'Ella', to: 'Yala', date: futureIsoDate(14),
      vehicle: 'car', pax: 2, bags: 2,
      customerName: 'Zone Test', customerEmail: 'zone@example.com', customerPhone: '+94770001111',
    };
    const a = await (await postBooking(plain, body)).json();
    const b = await (await postBooking(boosted, body)).json();
    expect(b.totalCents).toBeGreaterThan(a.totalCents);
  });
});
```

This file needs its own copy of the `zonesWith` helper from Task 1 (different test file, no shared
fixture module):

```ts
import { InMemoryZonesRepo, type NewZone } from '../db/zonesRepo';

async function zonesWith(...seed: NewZone[]): Promise<InMemoryZonesRepo> {
  const repo = new InMemoryZonesRepo();
  for (const z of seed) await repo.create(z);
  return repo;
}
```

Use the existing helpers in this file for app construction, booking POST and future dates — match whatever `bookings.test.ts` already uses (`futureIsoDate` comes from `testSupport/dates.ts`; never hardcode a date, it will fail at midnight UTC). If the file's existing booking helper has a different name or shape, use that one and keep the two-app comparison structure.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/bookings.test.ts -t "applies active hot zones"`
Expected: FAIL — both totals identical.

- [ ] **Step 3: Compose zones into the current card**

In `api/src/routes/bookings.ts`, add to the deps type:

```ts
zones?: ZonesRepo;
```

with imports:

```ts
import { InMemoryZonesRepo, type ZonesRepo } from '../db/zonesRepo';
import { liveRateCard } from '../quote/liveCard';
```

and inside the route factory:

```ts
const zonesRepo = deps.zones ?? new InMemoryZonesRepo();
```

Then in the card-resolution function at `:216-226`, replace both `RATE_CARD` returns and the `rateCardFor` call so the *current* card carries zones:

```ts
const current = await liveRateCard(zonesRepo);
try {
  const q = await quotes.get(quoteId);
  if (!q || q.channel !== 'web') return current;
  return rateCardFor(
    { rateCardJson: (q.rateCardJson ?? null) as RateCard | null, rateLockedUntil: q.rateLockedUntil },
    new Date(),
    current,
  ).rateCard;
} catch {
  return current;
}
```

A quote with a valid lock still returns its stored snapshot, so hot-zones spec C2 ("a quote locked with a zone keeps its price after the zone's % changes") continues to hold with no extra code.

- [ ] **Step 4: Wire the repo in app.ts**

In `api/src/app.ts:328`, add `zones,` to the `bookingRoutes({...})` argument object.

- [ ] **Step 5: Run the tests**

Run: `cd api && npx vitest run src/routes/bookings.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove no price moved**

Run: `cd api && npx vitest run src/quote/goldens.test.ts`
Expected: PASS.

- [ ] **Step 7: Full check and commit**

```bash
cd api && npm run check
git add api/src/routes/bookings.ts api/src/routes/bookings.test.ts api/src/app.ts
git commit -m "feat(pricing): apply active hot zones to the booking re-price"
```

---

### Task 4: Expand the server's known places

**Files:**
- Modify: `api/src/adapters/maps.ts:80-108` (`COORDS`), `:109-115` (`KNOWN_PLACES`)
- Test: `api/src/adapters/maps.test.ts`

**Interfaces:**
- Produces: `knownCoords(name)` resolves the 16 towns the front end already resolves but the server does not, so `offlineEstimate` can price them.

- [ ] **Step 1: Write the failing test**

Append to `api/src/adapters/maps.test.ts`:

```ts
import { KNOWN_PLACES } from './maps';

describe('server place vocabulary covers the front-end catalogue', () => {
  // Every town transfers-data.js can resolve must resolve here too, or migrating the site to
  // server-side pricing silently loses coverage the planner has today.
  const FRONT_END_TOWNS = [
    'Dambulla', 'Udawalawe', 'Tissamaharama', 'Tangalle', 'Unawatuna', 'Pasikudah',
    'Hatton', "Adam's Peak", 'Wilpattu', 'Kalpitiya', 'Jaffna', 'Haputale', 'Kitulgala',
    'Nilaveli', 'Ahangama', 'Hiriketiya',
  ];

  for (const town of FRONT_END_TOWNS) {
    it(`resolves ${town}`, async () => {
      const maps = new FakeMapsAdapter();
      const d = await maps.distance(town, 'Colombo City');
      expect(d, `${town} did not resolve`).not.toBeNull();
      expect(d!.km).toBeGreaterThan(0);
    });
  }
});
```

Match the file's existing import style for `FakeMapsAdapter` and `describe`/`it`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/adapters/maps.test.ts -t "front-end catalogue"`
Expected: FAIL — 16 failures, each `did not resolve`.

- [ ] **Step 3: Add the coordinates**

In `api/src/adapters/maps.ts`, add to the `COORDS` object (keys are `canonPlace()` output — lower-case, punctuation-stripped; match the existing entries' style):

```ts
  dambulla: [7.86, 80.65],
  udawalawe: [6.44, 80.89],
  tissamaharama: [6.28, 81.29],
  tangalle: [6.02, 80.79],
  unawatuna: [6.01, 80.25],
  pasikudah: [7.92, 81.56],
  hatton: [6.89, 80.6],
  'adams peak': [6.81, 80.5],
  wilpattu: [8.45, 80.05],
  kalpitiya: [8.23, 79.77],
  jaffna: [9.66, 80.02],
  haputale: [6.77, 80.96],
  kitulgala: [6.99, 80.41],
  nilaveli: [8.7, 81.19],
  ahangama: [5.97, 80.36],
  hiriketiya: [5.96, 80.69],
```

Coordinates are copied verbatim from `transfers-data.js` (`PLACES` and `EXTRA`), so the two catalogues agree. Verify the exact key `canonPlace("Adam's Peak")` produces before committing — if it strips the apostrophe to `adams peak`, the key above is right; if it yields something else, use that.

- [ ] **Step 4: Add the display names**

Add to `KNOWN_PLACES` in the same file, after the existing via-stops block:

```ts
  // Front-end catalogue parity (2026-08-12): every town transfers-data.js resolves.
  'Dambulla', 'Udawalawe', 'Tissamaharama', 'Tangalle', 'Unawatuna', 'Pasikudah',
  'Hatton', "Adam's Peak", 'Wilpattu', 'Kalpitiya', 'Jaffna', 'Haputale', 'Kitulgala',
  'Nilaveli', 'Ahangama', 'Hiriketiya',
```

- [ ] **Step 5: Run the tests**

Run: `cd api && npx vitest run src/adapters/maps.test.ts`
Expected: PASS.

- [ ] **Step 6: Full check and commit**

```bash
cd api && npm run check
git add api/src/adapters/maps.ts api/src/adapters/maps.test.ts
git commit -m "feat(maps): cover the front-end town catalogue server-side"
```

---

### Task 5: Estimated prices instead of refusal

**Files:**
- Modify: `api/src/routes/quote.ts:49-90` (`engineRequestFor`)
- Test: `api/src/routes/quote.test.ts`

**Interfaces:**
- Produces: `engineRequestFor(intent, maps): Promise<ResolvedIntent | null>` where

```ts
export interface ResolvedLeg { from: string; to: string; distanceKm: number; durationMin: number }
export interface ResolvedIntent { request: QuoteRequest; estimated: boolean; legs: ResolvedLeg[] }
```

Returns `null` only when a leg cannot be resolved **at all**; `estimated: true` when any leg's
distance came from the offline fallback. `legs` carries the durations Task 6 returns to the client,
so no caller re-queries the maps adapter.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/quote.test.ts`:

```ts
import { engineRequestFor } from './quote';

describe('engineRequestFor', () => {
  it('flags a request built on an estimated distance instead of refusing it', async () => {
    const maps = {
      provider: 'fake',
      places: async () => [],
      distanceVariants: async () => null,
      distance: async () => ({ km: 100, durationMin: 140, estimated: true }),
    };
    const out = await engineRequestFor(
      { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'A', to: 'B' }], extras: [] } as never,
      maps as never,
    );
    expect(out).not.toBeNull();
    expect(out!.estimated).toBe(true);
    expect(out!.request.legs[0].distanceKm).toBe(100);
  });

  it('reports estimated=false when every leg resolved for real', async () => {
    const maps = {
      provider: 'fake',
      places: async () => [],
      distanceVariants: async () => null,
      distance: async () => ({ km: 100, durationMin: 140 }),
    };
    const out = await engineRequestFor(
      { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'A', to: 'B' }], extras: [] } as never,
      maps as never,
    );
    expect(out!.estimated).toBe(false);
  });

  it('returns null when a leg cannot be resolved at all', async () => {
    const maps = {
      provider: 'fake',
      places: async () => [],
      distanceVariants: async () => null,
      distance: async () => null,
    };
    const out = await engineRequestFor(
      { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'A', to: 'B' }], extras: [] } as never,
      maps as never,
    );
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/quote.test.ts -t "engineRequestFor"`
Expected: FAIL — `engineRequestFor` is not exported, and it returns `null` for the estimated case.

- [ ] **Step 3: Change the signature**

In `api/src/routes/quote.ts`, export the function and change both branches. Replace the private-product early return:

```ts
if (resolved.some(({ distance }) => !distance || distance.estimated)) return null;
```

with:

```ts
if (resolved.some(({ distance }) => !distance)) return null;
const estimated = resolved.some(({ distance }) => distance!.estimated === true);
const legs: ResolvedLeg[] = resolved.map(({ leg, distance }) => ({
  from: leg.from,
  to: leg.to,
  distanceKm: distance!.km,
  durationMin: distance!.durationMin,
}));
```

and wrap the returned object:

```ts
return {
  estimated,
  legs,
  request: {
    product: 'private',
    vehicle: intent.vehicle,
    pax: intent.pax,
    bags: intent.bags,
    legs: legs.map(({ from, to, distanceKm }) => ({ from, to, distanceKm })),
    extras: intent.extras,
  },
};
```

Apply the identical changes to the chauffeur branch — build the same `legs` array from `day.from`/`day.to`, and map it into `travelDays` with each day's `date` preserved:

```ts
travelDays: resolved.map(({ day, distance }) => ({
  date: day.date,
  from: day.from,
  to: day.to,
  distanceKm: distance!.km,
})),
```

Add the exported types above the function and change its declaration to:

```ts
export interface ResolvedLeg { from: string; to: string; distanceKm: number; durationMin: number }
export interface ResolvedIntent { request: QuoteRequest; estimated: boolean; legs: ResolvedLeg[] }

export async function engineRequestFor(
  intent: WebQuoteIntent,
  maps: MapsAdapter,
): Promise<ResolvedIntent | null> {
```

- [ ] **Step 4: Update the one existing caller**

In `POST /v2/lock`, replace:

```ts
const engineRequest = await engineRequestFor(parsed.data, deps.maps);
if (!engineRequest) return c.json({ error: 'quote_unpriced' }, 422);
```

with:

```ts
const resolved = await engineRequestFor(parsed.data, deps.maps);
// A LOCK is a commitment, so it still refuses an estimated distance — only /estimate may show one.
if (!resolved || resolved.estimated) return c.json({ error: 'quote_unpriced' }, 422);
const engineRequest = resolved.request;
```

- [ ] **Step 5: Run the tests**

Run: `cd api && npx vitest run src/routes/quote.test.ts`
Expected: PASS — including the pre-existing `/v2/lock` tests, whose behaviour is unchanged.

- [ ] **Step 6: Full check and commit**

```bash
cd api && npm run check
git add api/src/routes/quote.ts api/src/routes/quote.test.ts
git commit -m "feat(quote): let the resolver report estimated distances instead of refusing"
```

---

### Task 6: `POST /quote/v2/estimate`

**Files:**
- Modify: `api/src/routes/quote.ts` (new handler)
- Test: `api/src/routes/quote.test.ts`

**Interfaces:**
- Consumes: `engineRequestFor` (Task 5), `liveCard()` (Task 2).
- Produces: `POST /quote/v2/estimate` → `200 { totalCents, amountDueNowCents, currency, lineItems, rateCardVersion, warnings, estimated: boolean, legs: [{ from, to, distanceKm, durationMin }] }`, or `422 { error: 'quote_unpriced' }`. Never persists. Never returns margin.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/quote.test.ts`:

```ts
describe('public quote v2 estimate', () => {
  function estimateApp(quotes = new InMemoryQuoteRepo()) {
    const app = new Hono();
    app.route('/quote', quoteRoutes({ quotes, maps: new FakeMapsAdapter(), v2Enabled: true }));
    return { app, quotes };
  }
  const send = (app: Hono, body: unknown) =>
    app.request('/quote/v2/estimate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('prices an intent without persisting a quote', async () => {
    const { app, quotes } = estimateApp();
    const res = await send(app, V2_PRIVATE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCents).toBeGreaterThan(0);
    expect(body.estimated).toBe(false);
    expect(quotes.all()).toHaveLength(0);
  });

  it('returns per-leg distance and duration', async () => {
    const { app } = estimateApp();
    const body = await (await send(app, V2_PRIVATE)).json();
    expect(body.legs).toHaveLength(1);
    expect(body.legs[0].distanceKm).toBeGreaterThan(0);
    expect(body.legs[0].durationMin).toBeGreaterThan(0);
  });

  it('never leaks margin', async () => {
    const { app } = estimateApp();
    const body = await (await send(app, V2_PRIVATE)).json();
    expect(body.marginEstimateCents).toBeUndefined();
  });

  it('is 404 when v2 is disabled', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    expect((await send(app as never, V2_PRIVATE)).status).toBe(404);
  });
});
```

If `InMemoryQuoteRepo` has no `all()`, use whatever list accessor it exposes; the assertion is "no quote row was written".

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/quote.test.ts -t "v2 estimate"`
Expected: FAIL — 404 on every case.

- [ ] **Step 3: Add the handler**

In `api/src/routes/quote.ts`, immediately before the `POST /v2/lock` handler:

```ts
// Price an intent WITHOUT persisting anything — the customer-side twin of the ops tool's
// /estimate (vs /save). Rendering a price must never write a quotes row. Unlike /v2/lock this
// will return a price built on an estimated distance, flagged so the page can label it and
// checkout can refuse it.
r.post('/v2/estimate', async (c) => {
  if (!deps.v2Enabled) return c.notFound();
  if (!deps.maps) return c.json({ error: 'not_available' }, 501);
  const parsed = WebQuoteIntentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
  }
  const resolved = await engineRequestFor(parsed.data, deps.maps);
  if (!resolved) return c.json({ error: 'quote_unpriced' }, 422);
  try {
    const result = quote(resolved.request, await liveCard());
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { marginEstimateCents, ...pub } = result;
    return c.json({ ...pub, estimated: resolved.estimated, legs: resolved.legs }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'BAD_REQUEST';
    return c.json({ error: ENGINE_ERRORS.has(msg) ? msg : 'BAD_REQUEST' }, 422);
  }
});
```

`resolved.legs` is the `ResolvedLeg[]` Task 5 produces — it already carries `durationMin`, so this handler makes no further maps calls.

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/routes/quote.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

```bash
cd api && npm run check
git add api/src/routes/quote.ts api/src/routes/quote.test.ts
git commit -m "feat(quote): add a non-persisting v2 estimate endpoint"
```

---

### Task 7: An estimated price can never be charged

**Files:**
- Test first: `api/src/routes/bookings.test.ts`
- Modify: `api/src/routes/bookings.ts:59-80` (`resolveTotals`) — only if the test proves it necessary.

**Interfaces:**
- Produces: a guarantee that a booking whose engine price could not be established never adopts the client's `quotedTotal` as its charge.

- [ ] **Step 1: Write the test that probes the current behaviour**

Append to `api/src/routes/bookings.test.ts`:

```ts
describe('an unpriced booking never charges the client-supplied figure', () => {
  it('ignores an inflated quotedTotal when the engine cannot price', async () => {
    // Maps resolves nothing, so the engine cannot price and the booking is "unpriced".
    const app = createApp({
      bookings: new InMemoryBookingRepo(),
      maps: { provider: 'none', places: async () => [], distanceVariants: async () => null, distance: async () => null },
    });
    const res = await postBooking(app, {
      mode: 'single', from: 'Nowhere Villa', to: 'Elsewhere Villa', date: futureIsoDate(14),
      vehicle: 'car', pax: 2, bags: 2, quotedTotal: 99_999_00,
      customerName: 'Unpriced', customerEmail: 'u@example.com', customerPhone: '+94770001111',
    });
    const body = await res.json();
    expect(body.totalCents).toBeLessThan(99_999_00);
  });
});
```

- [ ] **Step 2: Run it and record which way it goes**

Run: `cd api && npx vitest run src/routes/bookings.test.ts -t "never charges the client-supplied figure"`

`resolveTotals` at `:74` currently computes `Math.max(quotedTotal ?? 0, placeholderTotal)`, so this is expected to FAIL. If it PASSES, the guard already exists — keep the test as a regression guard, skip step 3, and go to step 4.

- [ ] **Step 3: Make the placeholder authoritative when unpriced**

In `api/src/routes/bookings.ts`, in the unpriced branch of `resolveTotals`, replace:

```ts
const total = Math.max(quotedTotal ?? 0, placeholderTotal);
```

with:

```ts
// The client's figure is a display value, not an authority. When the engine cannot price, the
// server's own placeholder stands and the booking is flagged unpriced — ops sets the real price
// before it can be paid. Adopting quotedTotal here would let a tampered or merely stale page
// dictate the charge.
const total = placeholderTotal;
```

Leave the `unpriced` flag and `UNPRICED_NOTE` behaviour exactly as they are.

- [ ] **Step 4: Run the full booking suite**

Run: `cd api && npx vitest run src/routes/bookings.test.ts`
Expected: PASS. If other tests asserted the old max() behaviour, read each one — if it encoded "the client's number wins", update it and note why in the commit body.

- [ ] **Step 5: Full check and commit**

```bash
cd api && npm run check
git add api/src/routes/bookings.ts api/src/routes/bookings.test.ts
git commit -m "fix(bookings): never charge a client-supplied total for an unpriced booking"
```

---

### Task 8: Bound the billed work per request

**Files:**
- Modify: `api/src/quote/webQuoteV2.ts` (leg/day caps)
- Test: `api/src/routes/quote.test.ts`

**Interfaces:**
- Produces: `/quote/v2/estimate` and `/quote/v2/lock` reject an intent whose leg count exceeds the cap, so one allowed request cannot trigger 31 billed distance lookups.

- [ ] **Step 1: Write the failing test**

Append to `api/src/routes/quote.test.ts`:

```ts
it('rejects an intent with more legs than the billed-work cap', async () => {
  const app = new Hono();
  app.route('/quote', quoteRoutes({ quotes: new InMemoryQuoteRepo(), maps: new FakeMapsAdapter(), v2Enabled: true }));
  const legs = Array.from({ length: 9 }, () => ({ from: 'Kandy', to: 'Ella' }));
  const res = await app.request('/quote/v2/estimate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...V2_PRIVATE, legs }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/routes/quote.test.ts -t "billed-work cap"`
Expected: FAIL — status 200, because the schema allows 16 legs.

- [ ] **Step 3: Lower the caps**

In `api/src/quote/webQuoteV2.ts`, change the private `legs` array bound from `.max(16)` to `.max(8)`, and the chauffeur `travelDays` bound from `.max(31)` to `.max(14)`.

```ts
// Each leg is a billed distance lookup, and the per-IP limiter counts REQUESTS, not lookups.
// Capping legs is what bounds the money one allowed request can spend (2026-08-12).
```

Confirm no existing test or fixture posts more legs than the new caps before committing; if the ops tool needs the higher bound it uses its own schema and is unaffected.

- [ ] **Step 4: Run the tests**

Run: `cd api && npx vitest run src/routes/quote.test.ts`
Expected: PASS.

- [ ] **Step 5: Set the Google console quota cap**

In the Google Cloud console for the **server** Maps key, set a daily request cap on the Distance
Matrix API. This is free, and it is the only backstop that survives an application bug — the
per-IP limiter and the leg cap both live in code that a regression can break.

Record the cap you set in the PR description. If the owner has to do this, say so in the PR rather
than leaving the step silently unchecked.

- [ ] **Step 6: Full check and commit**

```bash
cd api && npm run check
git add api/src/quote/webQuoteV2.ts api/src/routes/quote.test.ts
git commit -m "feat(quote): cap the billed distance lookups one request can trigger"
```

---

### Task 9: Wake the API on price-bearing pages

**Files:**
- Modify: `index.html`, `why.html`, `tours.html`, `tour.html`, `search.html`, `plan.html`
- Test: `web-tests/unit/warmup-ping.test.js` (create)

**Interfaces:**
- Produces: every page that will display an API-priced figure issues a `GET /health` on load, so a cold Render instance is waking while the visitor reads.

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/warmup-ping.test.js`:

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

// Every page that will show an API-priced figure must wake the instance on load. A cold Render
// free-tier start is measured in tens of seconds; the visitor should spend it reading, not waiting.
const PRICE_PAGES = ['index.html', 'why.html', 'tours.html', 'tour.html', 'search.html', 'plan.html'];

describe('price-bearing pages warm the API', () => {
  for (const page of PRICE_PAGES) {
    it(`${page} pings /health on load`, () => {
      const src = readFileSync(path.join(root, page), 'utf8');
      expect(src).toContain("/health");
    });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-tests && npx vitest run unit/warmup-ping.test.js`
Expected: FAIL for all six — only `booking.js` pings `/health` today.

Note: `web-tests` has its own `package.json` and `node_modules`; run vitest from that directory, never from the repo root.

- [ ] **Step 3: Add the ping**

In each of the six pages, directly after the existing error-beacon `<script>` block, add:

```html
<script>
/* Wake a cold API instance while the visitor reads — prices come from it. Fire-and-forget:
   a failure here must never surface, and never blocks rendering. */
(function(){try{fetch((window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com')+'/health',{method:'GET',cache:'no-store'}).catch(function(){})}catch(e){}})();
</script>
```

- [ ] **Step 4: Run the test**

Run: `cd web-tests && npx vitest run unit/warmup-ping.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole web suite**

Run: `cd web-tests && npm run test:all`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add index.html why.html tours.html tour.html search.html plan.html web-tests/unit/warmup-ping.test.js
git commit -m "perf(site): wake the API on pages that will show engine prices"
```

---

## What this plan deliberately does not do

- **No front-end pricing changes.** Every call site in the spec's appendix still uses the local formula. That is subsystem 3 onward.
- **No distance cache.** That is subsystem 2, and it carries a migration.
- **No `plan.js:167` `DAY_FEE` fix.** It is a live bug unrelated to this work and belongs in its own one-line PR.
- **No shared-ride changes.** Corridor seat prices stay generated.

## Follow-on plans

1. **Distance cache + comparison report** — the `distance_cache` table, seeded by a one-off baked-vs-live report the owner reviews. Includes a migration, so it needs explicit sign-off before merge.
2. **`booking.js`** — ~31 call sites, the money path.
3. **`plan.js`** — ~19 call sites, plus `guidePriceRange` and retiring the browser-side `CH_MAP.routeStats` Directions calls.
4. **Browse surfaces** — `index.html`, `tour.html`, `tours.html`, `why.html`, `search.js`.
5. **Mirror removal** — delete the local formula, retire `backend-price-parity.test.js`.

## Release note

Every task here merges to `main`, which auto-deploys to **staging** only. Nothing reaches production until a reviewed `main → production` promotion PR. **If any hot zone is active in production**, Tasks 2 and 3 raise real customer prices at that promotion — the owner must sign off with a delta report first. If no zone is active, this plan moves no prices at all.
