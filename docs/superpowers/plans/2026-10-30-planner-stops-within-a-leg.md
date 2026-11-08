# Planner Stops Within a Leg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer add stops inside one leg on `plan.html`, priced and stored exactly as the ops quote tool does it (one ride, segment-sum pricing, `viaStops` on the booking leg).

**Architecture:** Four PRs, each independently green. PR 1 adds `via[]` to the public quote intent and prices a via-leg as one engine `Ride`. PR 2 adds a `through[]` wire set to the trip booking (one migration) so the flat `stops[]` chain can say "this wire continues the same leg", and merges through-runs into one priced ride and one `booking_legs` row with `viaStops`. PR 3 teaches the booking page to carry and show stops. PR 4 is the planner UI: stop rows on the leg rail, hover `⇅ ×`, per-segment measurement, a consecutive-duplicate hard stop, and the ≥ 6 h "long day" ask.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres · vanilla JS front-end (`plan.js`, `booking.js`) · Playwright in `web-tests/`.

**Spec:** `docs/superpowers/specs/2026-10-30-planner-stops-within-a-leg-design.md`. **Prototype:** `docs/prototypes/planner-stops-ux.html`. Line numbers below are `origin/main` @ `40f999ca`; re-find by symbol if they drift.

## Global Constraints

- One PR per part below (CLAUDE.md hard rule 1). Branch from `origin/main`, in a worktree. Never `git add -A`.
- TDD: write the failing test, run it red, implement, run green, commit. Paste red→green in the PR.
- `cd api && npm run check` and `cd web-tests && npm run test:all` green before every commit that touches their tree. web-tests run from `web-tests/` (see memory). The api gate needs `DATABASE_URL_TEST` for the DB-backed suites.
- After editing ANY root asset (`plan.html`, `plan.js`, `booking.js`, `site.css`): run `npm run stamp` at the repo root and commit the stamped files, or CI goes red.
- No edits to `rateCard.ts`, `departureRepo.ts`, `config.ts`, any `@generated:` block, or `ch-map.js` (shared component — see Part D note).
- Caps (spec §2): `MAX_VIA_PER_LEG = 4`, `MAX_SEGMENTS_PER_INTENT = 12`, `MAX_TRIP_STOPS = 12` (existing, stops now include via places).
- Copy (spec §3): row label **"Stop on the way"**; link **"+ Add a stop on the way"** (no stops yet) / **"+ Add another stop"**; hard stop **"Same place twice in a row."**; ask **"Long day on the road."** with buttons **"Split it — end this leg at {place}"** / **"Keep it as one day"**; Next hints **"Fix Leg N to continue"** / **"Answer the note on Leg N to continue"**.
- Long-day threshold: total modelled drive time of a leg ≥ 360 min (ops `legDriveHours(leg) >= 6`).
- `via` is OPTIONAL in the intent, never defaulted to `[]`: a stored quote's `intentFingerprint` is `canonicalJson(parsed.data)` and a default would change every existing intent's fingerprint. Clients send `via` only when non-empty.
- Migration 0078 reaches staging on merge to `main` and prod on the `main → production` promote. Owner's explicit OK before merging PR 2.

---

## File map

| File | PR | Change |
|---|---|---|
| `api/src/quote/webQuoteV2.ts` | 1 | `via` on private legs + chauffeur days; `MAX_VIA_PER_LEG`, `MAX_SEGMENTS_PER_INTENT`, `intentSegments()`, segment-cap refine |
| `api/src/routes/quote.ts` | 1 | `engineRequestFor` measures a chain; `viaWithRoad()`; batch catalogue check covers via; `routeChoiceFor` bails on via |
| `api/src/quote/webQuoteV2.test.ts`, `api/src/routes/quote.test.ts`, `api/src/quote/quoteToBooking.test.ts` | 1 | tests |
| `api/drizzle/0078_trip_request_through.sql`, `api/drizzle/meta/_journal.json`, `api/src/db/tripRequestThroughMigration.test.ts` | 2 | migration |
| `api/src/db/schema.ts`, `api/src/domain/trip.ts`, `api/src/routes/bookings.ts`, `api/src/services/pricing.ts`, `api/src/domain/bookingLegs.ts`, `api/src/db/postgresBookingRepo.ts`, `api/scripts/backfill-booking-legs.ts`, `api/src/quote/quoteToBooking.ts` | 2 | `through` end to end |
| `booking.js` | 3 | parse `through`/`ack`; run-aware trip legs; intent `via`; payload `through`; notes line; edit link |
| `web-tests/e2e/booking-trip-stops.spec.js` | 3 | tests |
| `plan.html` (style block), `plan.js` | 4 | stop rows, controls, measurement, hard stop, long-day ask, hand-off |
| `web-tests/e2e/plan-stops.spec.js`, `web-tests/e2e/plan-stops-warnings.spec.js` | 4 | tests at 3 viewports |

---

# Part A — PR 1: quote intent `via`

Branch: `feat/quote-via`.

### Task 1: `via` on the intent schema

**Files:**
- Modify: `api/src/quote/webQuoteV2.ts:1-62`
- Test: `api/src/quote/webQuoteV2.test.ts`

**Interfaces:**
- Produces: `MAX_VIA_PER_LEG = 4`, `MAX_SEGMENTS_PER_INTENT = 12`, `intentSegments(intent: WebQuoteIntent): number`, `WebQuoteIntent` legs/travelDays gain `via?: string[]`.

- [ ] **Step 1: Confirm nobody introspects the schema object** (a `.superRefine` wraps it in `ZodEffects`, which has no `.options`/`.shape`).

Run: `cd api && grep -rn "WebQuoteIntentSchema\." src | grep -v "safeParse\|parse(" `
Expected: no output. If anything prints, stop and report — the cap moves into a route-level check instead.

- [ ] **Step 2: Write the failing tests** — append to `api/src/quote/webQuoteV2.test.ts`:

```ts
import { MAX_SEGMENTS_PER_INTENT, MAX_VIA_PER_LEG, intentSegments } from './webQuoteV2';

describe('web quote v2 — stops on the way (via)', () => {
  const leg = (via?: string[]) => ({ from: 'Kandy', to: 'Sigiriya / Dambulla', ...(via ? { via } : {}) });
  const intentWith = (legs: unknown[]) => ({ ...privateIntent, routeId: undefined, legs });

  it('accepts up to MAX_VIA_PER_LEG stops on a private leg and on a chauffeur day', () => {
    const four = ['Pinnawala', 'Kurunegala', 'Dambulla', 'Habarana'];
    expect(WebQuoteIntentSchema.safeParse(intentWith([leg(four)])).success).toBe(true);
    const day = { product: 'chauffeur', vehicle: 'car', pax: 2, bags: 1, firstDate: '2026-12-01', lastDate: '2026-12-01',
      travelDays: [{ date: '2026-12-01', from: 'Kandy', to: 'Ella', via: four }], extras: [] };
    expect(WebQuoteIntentSchema.safeParse(day).success).toBe(true);
    expect(MAX_VIA_PER_LEG).toBe(4);
  });

  it('refuses a fifth stop on one leg', () => {
    expect(WebQuoteIntentSchema.safeParse(intentWith([leg(['a', 'b', 'c', 'd', 'e'])])).success).toBe(false);
  });

  it('refuses a blank stop', () => {
    expect(WebQuoteIntentSchema.safeParse(intentWith([leg([' '])])).success).toBe(false);
  });

  it('caps the whole intent at MAX_SEGMENTS_PER_INTENT billed segments', () => {
    expect(MAX_SEGMENTS_PER_INTENT).toBe(12);
    const twelve = intentWith([leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b'])]); // 4 × 3 = 12
    expect(WebQuoteIntentSchema.safeParse(twelve).success).toBe(true);
    const thirteen = intentWith([leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b']), leg(['a', 'b']), leg()]); // 13
    expect(WebQuoteIntentSchema.safeParse(thirteen).success).toBe(false);
    expect(intentSegments(WebQuoteIntentSchema.parse(twelve))).toBe(12);
  });

  it('keeps every existing intent fingerprint: an absent via is not written as []', () => {
    expect(fingerprintIntent(WebQuoteIntentSchema.parse(privateIntent))).toBe(fingerprintIntent(privateIntent));
  });

  it('fingerprints stop order', () => {
    const a = fingerprintIntent(WebQuoteIntentSchema.parse(intentWith([leg(['Pinnawala', 'Dambulla'])])));
    const b = fingerprintIntent(WebQuoteIntentSchema.parse(intentWith([leg(['Dambulla', 'Pinnawala'])])));
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run, expect red**

Run: `cd api && npx vitest run src/quote/webQuoteV2.test.ts`
Expected: FAIL — `MAX_SEGMENTS_PER_INTENT`/`intentSegments` not exported; via intents rejected by `.strict()`.

- [ ] **Step 4: Implement** in `api/src/quote/webQuoteV2.ts`. Replace the `const Place = …` line and the whole `WebQuoteIntentSchema` with:

```ts
const Place = z.string().trim().min(1).max(500);
// Stops on the way inside ONE leg (spec 2026-10-30-planner-stops-within-a-leg-design.md §4.1).
// Optional, never defaulted: an intent's fingerprint is canonicalJson(parsed.data), so a default
// `[]` would re-fingerprint every stored quote. Clients send `via` only when it is non-empty.
export const MAX_VIA_PER_LEG = 4;
// Every segment (consecutive pair in a leg's chain) is a billed distance lookup. Until via,
// 8 legs × 1 segment bounded one request; this keeps that bound with stops in the chain.
export const MAX_SEGMENTS_PER_INTENT = 12;
const Via = z.array(Place).max(MAX_VIA_PER_LEG);

const PrivateLegIntent = z
  .object({
    from: Place,
    to: Place,
    via: Via.optional(),
    // Customer route choice (spec 2026-09-26 §4.1): ASK for a road, never send a distance.
    routeVariant: z.enum(ROUTE_VARIANTS).optional(),
  })
  .strict();

const ChauffeurDayIntent = z
  .object({
    date: DateOnly,
    from: Place,
    to: Place,
    via: Via.optional(),
  })
  .strict();

const IntentUnion = z.discriminatedUnion('product', [
  z
    .object({
      product: z.literal('private'),
      ...Identity,
      vehicle: Vehicle,
      pax: z.number().int().min(1).max(14),
      bags: z.number().int().min(0).max(30),
      date: DateOnly.optional(),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      legs: z
        .array(PrivateLegIntent)
        .min(1)
        .max(8), // Each leg is at least one billed lookup — a no_tolls leg can cost up to 3 Google elements (1 distance + 2 comparison) — and the per-IP limiter counts REQUESTS, not lookups. With stops on the way the money bound is MAX_SEGMENTS_PER_INTENT (refined below); the leg cap stays as the shape bound (2026-08-12, 2026-10-30).
      extras: Extras,
    })
    .strict(),
  z
    .object({
      product: z.literal('chauffeur'),
      ...Identity,
      vehicle: Vehicle,
      pax: z.number().int().min(1).max(14),
      bags: z.number().int().min(0).max(30),
      firstDate: DateOnly,
      lastDate: DateOnly,
      travelDays: z
        .array(ChauffeurDayIntent)
        .min(1)
        .max(14), // Same reasoning as legs above: the shape bound; MAX_SEGMENTS_PER_INTENT is the money bound.
      extras: Extras,
    })
    .strict(),
]);

export type WebQuoteIntent = z.infer<typeof IntentUnion>;

/** Billed segments in an intent: one per consecutive pair of each leg's chain. */
export function intentSegments(intent: WebQuoteIntent): number {
  const legs = intent.product === 'private' ? intent.legs : intent.travelDays;
  return legs.reduce((n, l) => n + 1 + (l.via?.length ?? 0), 0);
}

export const WebQuoteIntentSchema = IntentUnion.superRefine((intent, ctx) => {
  if (intentSegments(intent) > MAX_SEGMENTS_PER_INTENT) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_SEGMENTS_PER_INTENT} segments per quote`, path: ['legs'] });
  }
});
```

Delete the old `export type WebQuoteIntent = z.infer<typeof WebQuoteIntentSchema>;` line (the type now comes from `IntentUnion`).

- [ ] **Step 5: Run, expect green**

Run: `cd api && npx vitest run src/quote/webQuoteV2.test.ts`
Expected: PASS (all, including the pre-existing cases).

- [ ] **Step 6: Typecheck the consumers** — `cd api && npm run typecheck`. Expected: clean (the type is structurally identical plus optional `via`).

- [ ] **Step 7: Commit**

```bash
git add api/src/quote/webQuoteV2.ts api/src/quote/webQuoteV2.test.ts
git commit -m "feat(quote): accept stops on the way (via) in the web quote intent"
```

### Task 2: price a via-leg as one ride

**Files:**
- Modify: `api/src/routes/quote.ts:66-132` (`ResolvedLeg`, `engineRequestFor`), `:164-166` (`carriesRoad`), `:142-162` (`routeChoiceFor`), `:294-316` (`/v2/estimate` head)
- Test: `api/src/routes/quote.test.ts`

**Interfaces:**
- Consumes: `WebQuoteIntent.legs[i].via?`, `measureLeg(maps, from, to, want?)` from `../quote/routeChoice`, `Ride` from `../quote/types`.
- Produces: `ResolvedLeg.via?: string[]`; `engineRequestFor` returns `request.legs[i]` as `Ride` (`{stops, segmentKms}`) when the leg has via, else the old `{from,to,distanceKm}`; `export function viaWithRoad(intent): boolean`.

- [ ] **Step 1: Write the failing tests** — add to `api/src/routes/quote.test.ts` inside `describe('public quote v2 lock', …)` after the `v2App` helper (it is in scope there):

```ts
  describe('stops on the way (via)', () => {
    const chain = ['Kandy', 'Sigiriya / Dambulla', 'Ella'];
    const viaIntent = { ...V2_PRIVATE, routeId: undefined, legs: [{ from: chain[0], to: chain[2], via: [chain[1]] }] };
    const pairwise = { ...V2_PRIVATE, routeId: undefined, legs: [{ from: chain[0], to: chain[1] }, { from: chain[1], to: chain[2] }] };
    const est = (app: Hono, body: unknown) =>
      app.request('/quote/v2/estimate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('prices the chain as ONE ride (segment sum, one minimum) and echoes the stops', async () => {
      const { app } = v2App();
      const maps = new FakeMapsAdapter();
      const a = (await maps.distance(chain[0], chain[1]))!;
      const b = (await maps.distance(chain[1], chain[2]))!;
      const res = await est(app, viaIntent);
      expect(res.status).toBe(200);
      const body = await res.json();
      const oneRide = priceQuote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ stops: chain, segmentKms: [a.km, b.km] }], extras: [] }, RATE_CARD);
      expect(body.totalCents).toBe(oneRide.totalCents);
      expect(body.legs).toEqual([{ from: chain[0], to: chain[2], via: [chain[1]], distanceKm: a.km + b.km, durationMin: a.durationMin + b.durationMin }]);
    });

    it('is cheaper than, or equal to, the same places booked as separate legs (one floor, not two)', async () => {
      // Weligama → Mirissa → Weligama: two tiny segments. Pairwise = two legs, each at the car
      // minimum; as one ride the floor applies once. If the fake adapter does not know one of
      // these towns the test fails on status, not on the assertion — pick another short pair.
      const { app } = v2App();
      const short = { ...viaIntent, legs: [{ from: 'Weligama', to: 'Weligama', via: ['Mirissa'] }] };
      const twoLegs = { ...viaIntent, legs: [{ from: 'Weligama', to: 'Mirissa' }, { from: 'Mirissa', to: 'Weligama' }] };
      const one = await (await est(app, short)).json();
      const two = await (await est(app, twoLegs)).json();
      expect(one.totalCents).toBeLessThan(two.totalCents);
    });

    it('refuses a road choice on a leg that has stops (ops GC-10)', async () => {
      const { app } = v2App();
      const res = await est(app, { ...viaIntent, legs: [{ ...viaIntent.legs[0], routeVariant: 'no_tolls' }] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('route_choice_not_supported');
    });

    it('lock refuses the same', async () => {
      const { app } = v2App();
      const res = await postLock(app, { ...viaIntent, legs: [{ ...viaIntent.legs[0], routeVariant: 'no_tolls' }] });
      expect(res.status).toBe(400);
    });

    it('a via leg never gets a route comparison (compareRoutes is ignored, not an error)', async () => {
      const { app } = v2App();
      const body = await (await est(app, { ...viaIntent, compareRoutes: true })).json();
      expect(body.routeChoice).toBeUndefined();
    });

    it('a chauffeur day with stops prices as one ride day', async () => {
      const { app } = v2App();
      const day = { product: 'chauffeur', vehicle: 'car', pax: 2, bags: 2, firstDate: '2026-12-01', lastDate: '2026-12-01',
        travelDays: [{ date: '2026-12-01', from: chain[0], to: chain[2], via: [chain[1]] }], extras: [] };
      const res = await est(app, day);
      expect(res.status).toBe(200);
      expect((await res.json()).legs[0].via).toEqual([chain[1]]);
    });

    it('locks and converts a via quote with the stops intact', async () => {
      const { app, quotes } = v2App();
      const res = await postLock(app, viaIntent);
      expect(res.status).toBe(200);
      const saved = (await quotes.list())[0];
      const engine = (saved.request as { engine: { legs: unknown[] } }).engine;
      expect(engine.legs[0]).toMatchObject({ stops: chain });
    });

    // Also pin the unchanged path: a plain two-place leg still produces the old leg shape, byte
    // for byte, so every existing stored quote and every ops drawer reads as before.
    it('leaves a plain leg in the old {from,to,distanceKm} shape', async () => {
      const { app } = v2App();
      const body = await (await est(app, pairwise)).json();
      expect(body.legs[0]).not.toHaveProperty('via');
      expect(body.legs[0]).not.toHaveProperty('stops');
    });
  });
```

`postLock` and `v2App` already exist in this file; `priceQuote`, `RATE_CARD`, `FakeMapsAdapter`, `Hono` are already imported.

- [ ] **Step 2: Run, expect red**

Run: `cd api && npx vitest run src/routes/quote.test.ts -t "stops on the way"`
Expected: FAIL — via legs priced as from→to only (`legs[0]` has no `via`), 200 instead of 400 on the road case.

- [ ] **Step 3: Implement** in `api/src/routes/quote.ts`.

Replace the `ResolvedLeg` interface and `engineRequestFor` with:

```ts
export interface ResolvedLeg { from: string; to: string; via?: string[]; distanceKm: number; durationMin: number; routeVariant?: RouteVariant }
export interface ResolvedIntent { request: QuoteRequest; estimated: boolean; legs: ResolvedLeg[] }

// One billed lookup per consecutive pair of the leg's chain. A chain has no road choice (ops
// GC-10, refused upstream by viaWithRoad), so segments are always measured on the default road.
async function measureChain(
  maps: MapsAdapter,
  chain: string[],
): Promise<{ segmentKms: number[]; km: number; durationMin: number; estimated: boolean } | null> {
  const segments = await Promise.all(chain.slice(1).map((to, i) => maps.distance(chain[i]!, to)));
  if (segments.some((s) => !s)) return null;
  return {
    segmentKms: segments.map((s) => s!.km),
    km: segments.reduce((n, s) => n + s!.km, 0),
    durationMin: segments.reduce((n, s) => n + s!.durationMin, 0),
    estimated: segments.some((s) => s!.estimated === true),
  };
}

export async function engineRequestFor(
  intent: WebQuoteIntent,
  maps: MapsAdapter,
): Promise<ResolvedIntent | null> {
  if (intent.product === 'private') {
    const resolved = await Promise.all(
      intent.legs.map(async (leg) => {
        if (leg.via?.length) {
          const chain = [leg.from, ...leg.via, leg.to];
          const m = await measureChain(maps, chain);
          return m ? { leg, chain, km: m.km, durationMin: m.durationMin, estimated: m.estimated, segmentKms: m.segmentKms, variant: undefined } : null;
        }
        const d = await measureLeg(maps, leg.from, leg.to, leg.routeVariant);
        return d ? { leg, chain: null, km: d.km, durationMin: d.durationMin, estimated: d.estimated === true, segmentKms: [d.km], variant: d.variant } : null;
      }),
    );
    if (resolved.some((r) => !r)) return null;
    const rs = resolved.map((r) => r!);
    const estimated = rs.some((r) => r.estimated);
    const legs: ResolvedLeg[] = rs.map((r) => ({
      from: r.leg.from,
      to: r.leg.to,
      ...(r.chain ? { via: r.leg.via } : {}),
      distanceKm: r.km,
      durationMin: r.durationMin,
      // Echoed ONLY when asked, so every existing caller's response is byte-identical.
      ...(r.leg.routeVariant ? { routeVariant: r.variant } : {}),
    }));
    return {
      estimated,
      legs,
      request: {
        product: 'private',
        vehicle: intent.vehicle,
        pax: intent.pax,
        bags: intent.bags,
        // A chain is ONE ride (spec 2026-10-30 §2): the engine prices its segment sum with one
        // minimum. A plain leg keeps the old shape so stored quotes stay byte-identical.
        legs: rs.map((r) => (r.chain ? { stops: r.chain, segmentKms: r.segmentKms } : { from: r.leg.from, to: r.leg.to, distanceKm: r.km })),
        extras: intent.extras,
      },
    };
  }
  const resolved = await Promise.all(
    intent.travelDays.map(async (day) => {
      const chain = [day.from, ...(day.via ?? []), day.to];
      const m = await measureChain(maps, chain);
      return m ? { day, chain: day.via?.length ? chain : null, ...m } : null;
    }),
  );
  if (resolved.some((r) => !r)) return null;
  const rs = resolved.map((r) => r!);
  const estimated = rs.some((r) => r.estimated);
  const legs: ResolvedLeg[] = rs.map((r) => ({
    from: r.day.from,
    to: r.day.to,
    ...(r.chain ? { via: r.day.via } : {}),
    distanceKm: r.km,
    durationMin: r.durationMin,
  }));
  return {
    estimated,
    legs,
    request: {
      product: 'chauffeur',
      vehicle: intent.vehicle,
      pax: intent.pax,
      bags: intent.bags,
      firstDate: intent.firstDate,
      lastDate: intent.lastDate,
      travelDays: rs.map((r) => (r.chain
        ? { date: r.day.date, stops: r.chain, segmentKms: r.segmentKms }
        : { date: r.day.date, from: r.day.from, to: r.day.to, distanceKm: r.km })),
      extras: intent.extras,
    },
  };
}
```

Below `carriesRoad`, add:

```ts
// A leg with stops on the way has no road choice (ops GC-10: adding a stop clears the road).
export function viaWithRoad(intent: WebQuoteIntent): boolean {
  return intent.product === 'private' && intent.legs.some((l) => (l.via?.length ?? 0) > 0 && l.routeVariant !== undefined);
}
```

In `routeChoiceFor`, after `const leg = intent.legs[0]!;` add:

```ts
  if (leg.via?.length) return null; // a chain is one ride on the default road — nothing to compare
```

In `/v2/estimate`, directly after the `if (!parsed.success) …` block, add:

```ts
    if (viaWithRoad(parsed.data)) return c.json({ error: 'route_choice_not_supported' }, 400);
```

In `/v2/lock`, change `if (carriesRoad(parsed.data))` to `if (carriesRoad(parsed.data) || viaWithRoad(parsed.data))`.

- [ ] **Step 4: Run, expect green**

Run: `cd api && npx vitest run src/routes/quote.test.ts`
Expected: PASS, including every pre-existing estimate/lock/update case (the plain-leg path is unchanged in shape).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/quote.ts api/src/routes/quote.test.ts
git commit -m "feat(quote): price a leg with stops on the way as one ride"
```

### Task 3: batch pricing and the catalogue rule

**Files:**
- Modify: `api/src/routes/quote.ts:386-394` (inside `/v2/estimate-batch`)
- Test: `api/src/routes/quote.test.ts` (`describe('public quote v2 estimate-batch')`)

- [ ] **Step 1: Failing tests** — add inside the estimate-batch describe:

```ts
  it('prices a via intent when every place in the chain is a catalogue town', async () => {
    const { app } = batchApp();
    const via = { ...intent('Kandy', 'Ella'), legs: [{ from: 'Kandy', to: 'Ella', via: ['Sigiriya / Dambulla'] }] };
    const { results } = await (await post(app, '/quote/v2/estimate-batch', { intents: [via] })).json();
    expect(results[0]).not.toBeNull();
    const one = await (await post(app, '/quote/v2/estimate', via)).json();
    expect(results[0].totalCents).toBe(one.totalCents);
  });

  it('nulls a via intent whose stop is not a catalogue town, without touching the adapter', async () => {
    const inner = new FakeMapsAdapter();
    const asked: string[] = [];
    const spy: MapsAdapter = Object.assign(Object.create(inner), {
      distance: (a: string, b: string) => { asked.push(`${a}|${b}`); return inner.distance(a, b); },
    });
    const { app } = batchApp(spy);
    const via = { ...intent('Kandy', 'Ella'), legs: [{ from: 'Kandy', to: 'Ella', via: ['Pinnawala Elephant Orphanage'] }] };
    const { results } = await (await post(app, '/quote/v2/estimate-batch', { intents: [via] })).json();
    expect(results[0]).toBeNull();
    expect(asked).toEqual([]);
  });
```

- [ ] **Step 2: Run red** — `cd api && npx vitest run src/routes/quote.test.ts -t "via intent"`. Expected: the second test FAILS (adapter asked about Pinnawala).

- [ ] **Step 3: Implement** — in `/v2/estimate-batch` replace the catalogue line with:

```ts
        // Every place in the chain, stops included: a batch may never fan arbitrary addresses out to Google.
        if (!parsed.data.legs.every((l) => [l.from, ...(l.via ?? []), l.to].every(isCatalogTown))) return null;
```

- [ ] **Step 4: Run green** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/quote.ts api/src/routes/quote.test.ts
git commit -m "feat(quote): estimate-batch checks every stop in a chain against the catalogue"
```

### Task 4: a via quote converts to a booking with its stops

**Files:**
- Test only: `api/src/quote/quoteToBooking.test.ts`

`chainStops` (`quoteToBooking.ts:40`) already flattens a 3+-stop ride. This pins it for the web path; PR 2 Task 12 extends it with `through`.

- [ ] **Step 1: Add the test** (mirror an existing private-trip case in that file for `SavedQuote`/`BookingDetails` fixtures — reuse its helper names; do not invent new ones):

```ts
  it('a web via-leg converts to a trip whose stops include the stop on the way, with no gap', () => {
    const q = savedPrivateQuote({ legs: [{ stops: ['Kandy', 'Sigiriya / Dambulla', 'Ella'], segmentKms: [90, 180] }] });
    const out = quoteToBooking(q, details);
    expect(out.mode).toBe('trip');
    expect(out.input).toMatchObject({ stops: ['Kandy', 'Sigiriya / Dambulla', 'Ella'], nights: [0, 0] });
    expect((out.input as { gaps?: number[] }).gaps).toBeUndefined();
  });
```

If the file's fixture builder has a different name than `savedPrivateQuote`/`details`, use that file's names — the assertion is what matters.

- [ ] **Step 2: Run** — `cd api && npx vitest run src/quote/quoteToBooking.test.ts`. Expected: PASS already (this is a pin, not a change). If it fails, the chain is being dropped: stop and report.

- [ ] **Step 3: Commit**

```bash
git add api/src/quote/quoteToBooking.test.ts
git commit -m "test(quote): pin that a via ride converts to a trip with its stops"
```

### Task 5: gate and PR

- [ ] `cd api && npm run check` — Expected: typecheck clean, lint clean, Vitest summary all passed, exit 0.
- [ ] Open PR `feat/quote-via → main` titled "feat(quote): stops on the way (via) in the web quote intent (PR 1/4)". Body: spec link, red→green output from Tasks 1–3, note "no schema change, no rate card change, plain-leg responses byte-identical".

---

# Part B — PR 2: trip booking `through`

Branch: `feat/trip-through`. Independent of PR 1 (can be built in parallel; merge either first).

### Task 6: migration 0078

**Files:**
- Create: `api/drizzle/0078_trip_request_through.sql`
- Modify: `api/drizzle/meta/_journal.json`
- Create: `api/src/db/tripRequestThroughMigration.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

describe('0078_trip_request_through', () => {
  const sql = readFileSync(new URL('../../drizzle/0078_trip_request_through.sql', import.meta.url), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  it('adds a nullable integer[] column, idempotently', () => {
    expect(sql).toMatch(/alter table\s+"trip_request"\s+add column if not exists\s+"through"\s+integer\[\]/i);
    expect(sql).not.toMatch(/not null/i);
  });

  it('is journaled after 0077 so drizzle applies it on a database that already has 0077', () => {
    const e = journal.entries.find((x) => x.tag === '0078_trip_request_through');
    const prev = journal.entries.find((x) => x.tag === '0077_booking_payment_arrangement');
    expect(e).toBeDefined();
    expect(prev).toBeDefined();
    expect(e!.idx).toBe(78);
    expect(e!.when).toBeGreaterThan(prev!.when);
  });
});
```

- [ ] **Step 2: Run red** — `cd api && npx vitest run src/db/tripRequestThroughMigration.test.ts`. Expected: FAIL (file missing).

- [ ] **Step 3: Create** `api/drizzle/0078_trip_request_through.sql`:

```sql
-- Stops on the way inside one leg (spec 2026-10-30-planner-stops-within-a-leg-design.md §4.2).
-- Hand-written: drizzle-kit generate needs a TTY. Indexes of the wires (stops[i] → stops[i+1])
-- the car drives STRAIGHT ON from: stops[i+1] is a stop on the way, not an overnight, and the
-- same leg continues on wire i+1. Pricing groups a through-run into one ride; booking_legs
-- stores it as one row with via_stops. Additive, nullable, no backfill: null means no through
-- wires, which is today's reading of every existing row. A nullable ADD COLUMN takes no rewrite
-- and no long lock on Postgres 11+.
-- RELEASE ORDER IS HARD: this migration (when 1792540800000) must release AFTER
-- 0077_booking_payment_arrangement (when 1792454400000) — drizzle applies only migrations newer
-- than the last one applied. Rollback: ALTER TABLE "trip_request" DROP COLUMN "through".
ALTER TABLE "trip_request" ADD COLUMN IF NOT EXISTS "through" integer[];
```

Append to `api/drizzle/meta/_journal.json` `entries` (after the 0077 entry):

```json
    {
      "idx": 78,
      "version": "7",
      "when": 1792540800000,
      "tag": "0078_trip_request_through",
      "breakpoints": true
    }
```

- [ ] **Step 4: Run green** — same command. Expected: PASS.

- [ ] **Step 5: Apply locally** — `cd api && npm run migrate` (local dev DB only; `api/.env`'s `DATABASE_URL` is PROD per memory — confirm `echo $DATABASE_URL` points at localhost before running, or run against `DATABASE_URL_TEST` with `DATABASE_URL=$DATABASE_URL_TEST npm run migrate`). Expected: `0078_trip_request_through` applied.

- [ ] **Step 6: Commit**

```bash
git add api/drizzle/0078_trip_request_through.sql api/drizzle/meta/_journal.json api/src/db/tripRequestThroughMigration.test.ts
git commit -m "feat(db): trip_request.through — wires that continue the same leg (migration 0078)"
```

### Task 7: schema column and `TripInput.through`

**Files:**
- Modify: `api/src/db/schema.ts:313-316`, `api/src/domain/trip.ts:14-38`
- Test: `api/src/domain/trip.test.ts`

**Interfaces:**
- Produces: `TripInput.through?: number[]`; `tripRequests.through: integer[] | null`.

- [ ] **Step 1: Failing tests** — append to `api/src/domain/trip.test.ts`:

```ts
  it('accepts through wire indexes', () => {
    expect(TripInput.safeParse({ ...valid, through: [0] }).success).toBe(true);
  });
  it('refuses a negative or fractional through index', () => {
    expect(TripInput.safeParse({ ...valid, through: [-1] }).success).toBe(false);
    expect(TripInput.safeParse({ ...valid, through: [0.5] }).success).toBe(false);
  });
```

- [ ] **Step 2: Run red** — `cd api && npx vitest run src/domain/trip.test.ts`. Expected: first new test FAILS (`.strict()`? No — `TripInput` is not strict; it fails because… it passes). **If both pass already, the object is non-strict and ignores unknown keys** — then the red step is the second test only. Either way continue.

- [ ] **Step 3: Implement.** In `api/src/domain/trip.ts` after `routeVariants`:

```ts
  // Stops on the way (spec 2026-10-30 §4.2): wire i in `through` is driven straight on — stops[i+1]
  // is a stop inside the same leg, not an overnight. Cross-field rules (not a gap, nights 0, same
  // date, no road, never the last wire) live in the route handler like gaps' do.
  through: z.array(z.number().int().min(0)).max(MAX_TRIP_STOPS - 1).optional(),
```

In `api/src/db/schema.ts` after `gaps`:

```ts
  // Wires the car drives straight on from (0078_trip_request_through): stops[i+1] is a stop on the
  // way inside one leg. Null means none — every pair is its own leg.
  through: integer('through').array(),
```

- [ ] **Step 4: Run green** — `cd api && npx vitest run src/domain/trip.test.ts && npm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/schema.ts api/src/domain/trip.ts api/src/domain/trip.test.ts
git commit -m "feat(trip): through[] on TripInput and trip_request"
```

### Task 8: validate `through` at the booking route

**Files:**
- Modify: `api/src/routes/bookings.ts:580-592` (next to `tripGapsProblem`), `:720-728` (call site)
- Test: `api/src/routes/bookings.test.ts`

**Interfaces:**
- Produces: `function tripThroughProblem(t: TripInput): string | null`.

- [ ] **Step 1: Failing tests** — append a describe to `api/src/routes/bookings.test.ts`:

```ts
describe('POST /bookings/trip — through (stops on the way)', () => {
  const send = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request('/bookings/trip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const base = () => ({
    stops: ['Kandy', 'Sigiriya / Dambulla', 'Ella'], nights: [0, 0, 0], pax: 2, vehicleType: 'car', serviceType: 'private', customer: valid.customer,
  });
  const app = () => createApp({ bookings: new InMemoryBookingRepo() });

  it('accepts a through wire and stores it on the booking', async () => {
    const res = await send(app(), { ...base(), through: [0] });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.input.through).toEqual([0]);
  });

  it.each([
    ['the last wire (nothing to continue onto)', { through: [1] }],
    ['a wire past the end', { through: [5] }],
    ['a duplicate', { through: [0, 0] }],
    ['a wire that is also a gap', { through: [0], gaps: [0] }],
    ['a night at the stop on the way', { through: [0], nights: [0, 1, 0] }],
    ['a different date on the continuing wire', { through: [0], dates: [futureIsoDate(30), futureIsoDate(31)] }],
    ['a road choice on a wire inside the run', { through: [0], routeVariants: ['no_tolls', 'fastest'] }],
  ])('refuses %s', async (_label, patch) => {
    const res = await send(app(), { ...base(), ...patch });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/^through: /);
  });
});
```

`futureIsoDate` is already imported in this file.

- [ ] **Step 2: Run red** — `cd api && npx vitest run src/routes/bookings.test.ts -t "through"`. Expected: the refusals FAIL (201 instead of 400).

- [ ] **Step 3: Implement.** Below `tripGapsProblem` in `api/src/routes/bookings.ts`:

```ts
// Stops on the way (TripInput.through): wire i continues the same leg onto wire i+1, so stops[i+1]
// is a stop, not an overnight. Each rule here is a shape the planner never produces; a violation
// means a hand-built or stale request, and pricing it would silently merge or split legs.
function tripThroughProblem(t: TripInput): string | null {
  const through = t.through ?? [];
  if (!through.length) return null;
  const wires = t.stops.length - 1;
  if (new Set(through).size !== through.length) return 'each wire can be listed once';
  if (through.some((w) => w >= wires - 1)) return `only wires 0–${Math.max(0, wires - 2)} can continue onto a next wire`;
  const gaps = new Set(t.gaps ?? []);
  if (through.some((w) => gaps.has(w) || gaps.has(w + 1))) return 'a stop on the way cannot sit on a self-arranged stretch';
  if (through.some((w) => (t.nights[w + 1] ?? 0) !== 0)) return 'a stop on the way has no nights';
  const dates = t.dates ?? [];
  if (through.some((w) => dates[w] && dates[w + 1] && dates[w] !== dates[w + 1])) return 'a leg with stops runs on one date';
  const rv = t.routeVariants ?? [];
  const inRun = new Set(through.flatMap((w) => [w, w + 1]));
  if ([...inRun].some((w) => rv[w] === 'no_tolls')) return 'a leg with stops has no road choice';
  return null;
}
```

In the `/trip` handler, directly after the `gapsProblem` check:

```ts
    const throughProblem = tripThroughProblem(parsed.data);
    if (throughProblem) return c.json({ error: 'invalid_request', message: `through: ${throughProblem}` }, 400);
```

- [ ] **Step 4: Run green** — same command. Expected: PASS. (The accept case passes once Task 11's repo change lands for Postgres; `InMemoryBookingRepo` stores `input` verbatim, so it passes now.)

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/bookings.ts api/src/routes/bookings.test.ts
git commit -m "feat(bookings): validate through wires on a trip booking"
```

### Task 9: price a through-run as one ride

**Files:**
- Modify: `api/src/services/pricing.ts:128-191` (`chauffeurDates`, `priceTrip`)
- Test: `api/src/services/pricing.test.ts`

**Interfaces:**
- Consumes: `Ride` from `../quote/types`, `measureLeg`.
- Produces: `priceTrip` unchanged signature; internal `tripRides(input): { wires: number[] }[]`.

- [ ] **Step 1: Failing tests** — append to `api/src/services/pricing.test.ts` (the file already has `knownTrip`, `maps`, `quote`, `RATE_CARD`):

```ts
describe('priceTrip — through (stops on the way)', () => {
  const chain = ['Colombo Airport (CMB)', 'Kandy', 'Ella'];
  it('prices a through-run as ONE ride with one minimum, equal to the engine Ride price', async () => {
    const a = (await maps.distance(chain[0], chain[1]))!;
    const b = (await maps.distance(chain[1], chain[2]))!;
    const p = await priceTrip({ ...knownTrip, stops: chain, through: [0] }, maps);
    const ride = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 0, legs: [{ stops: chain, segmentKms: [a.km, b.km] }] }, RATE_CARD);
    expect(p.priced).toBe(true);
    expect(p.totalCents).toBe(ride.totalCents);
  });

  it('still prices the same three stops pairwise when nothing is through (the pinned web path)', async () => {
    const p = await priceTrip({ ...knownTrip, stops: chain }, maps);
    expect(p.totalCents).toBe(8900); // CMB→Kandy 4991 + Kandy→Ella 3945 — unchanged
  });

  it('chauffeur: a through-run is one travel day dated by its first wire', async () => {
    const dates = ['2026-12-01', '2026-12-01', '2026-12-03'];
    const p = await priceTrip({ ...knownTrip, stops: [...chain, 'Galle'], dates, through: [0], serviceType: 'chauffeur' }, maps);
    expect(p.priced).toBe(true);
    const days = (p.breakdown as { lineItems: { label: string }[] }).lineItems.map((l) => l.label);
    expect(days.some((l) => l.includes('Colombo Airport (CMB) → Kandy → Ella'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run red** — `cd api && npx vitest run src/services/pricing.test.ts -t "through"`. Expected: first and third FAIL.

- [ ] **Step 3: Implement.** In `api/src/services/pricing.ts`, add near the top (after imports):

```ts
import type { Ride } from '../quote/types';

// The rides a trip's wires form. A wire in `through` continues the current ride onto the next
// wire; a gap wire belongs to no ride. Each ride remembers its wires so dates and road choices
// can be read per wire.
function tripRides(input: TripInput): { wires: number[] }[] {
  const gaps = new Set(input.gaps ?? []);
  const through = new Set(input.through ?? []);
  const rides: { wires: number[] }[] = [];
  let cur: { wires: number[] } | null = null;
  for (let i = 0; i < input.stops.length - 1; i++) {
    if (gaps.has(i)) { cur = null; continue; }
    if (!cur) { cur = { wires: [] }; rides.push(cur); }
    cur.wires.push(i);
    if (!through.has(i)) cur = null;
  }
  return rides;
}
```

Replace `chauffeurDates` signature and body so it takes rides with their first wire:

```ts
function chauffeurDates(input: TripInput, legs: { wire: number; ride: Ride }[]): {
  firstDate: string;
  lastDate: string;
  travelDays: ChauffeurRideDay[];
} {
  const real = legs.map((l) => input.dates?.[l.wire]);
  if (real.every((d) => d && isUsableDate(d))) {
    const sorted = [...(real as string[])].sort();
    return {
      firstDate: sorted[0],
      lastDate: sorted[sorted.length - 1],
      travelDays: legs.map((l, i) => ({ date: real[i] as string, ...l.ride })),
    };
  }
  const days = input.days ?? legs.length;
  const lastDate = addDays(SYNTHETIC_FIRST_DATE, days - 1);
  return {
    firstDate: SYNTHETIC_FIRST_DATE,
    lastDate,
    travelDays: legs.map((l, i) => ({ date: i < days ? addDays(SYNTHETIC_FIRST_DATE, i) : lastDate, ...l.ride })),
  };
}
```

(`ChauffeurRideDay` is exported from `../quote/types`; import it alongside `ChauffeurTravelDay` and drop `ChauffeurTravelDay` if it becomes unused.)

Replace the body of `priceTrip`:

```ts
export async function priceTrip(
  input: TripInput,
  maps: MapsAdapter,
  rateCard: RateCard = RATE_CARD,
  discount?: DiscountRequest,
): Promise<PriceOutcome> {
  const legs: { wire: number; ride: Ride }[] = [];
  for (const r of tripRides(input)) {
    const stops = [input.stops[r.wires[0]], ...r.wires.map((w) => input.stops[w + 1])];
    const segmentKms: number[] = [];
    for (const i of r.wires) {
      const from = input.stops[i];
      const to = input.stops[i + 1];
      let leg = null;
      try {
        leg = await measureLeg(maps, from, to, input.routeVariants?.[i]);
      } catch {
        leg = null;
      }
      if (!leg) return unpriced(`distance unresolved: ${from} → ${to}`);
      if (leg.estimated) return unpriced(`${ESTIMATED_DISTANCE}: ${from} → ${to}`);
      // A booking NEVER silently switches road (spec §4.2): the customer saw the local-road price.
      if (input.routeVariants?.[i] === 'no_tolls' && leg.variant !== 'no_tolls') {
        throw new InvalidPricingRequestError(ROUTE_CHOICE_UNAVAILABLE);
      }
      segmentKms.push(leg.km);
    }
    legs.push({ wire: r.wires[0], ride: { stops, segmentKms } });
  }

  const vehicle = input.vehicleType === 'van' ? 'van' : 'car';
  if (input.serviceType === 'chauffeur') {
    // Public trips don't collect a bag count — pax alone drives the capacity upgrade.
    return runEngine({ product: 'chauffeur', vehicle, pax: input.pax, bags: 0, ...chauffeurDates(input, legs) }, rateCard, discount);
  }
  // Public trips don't collect a bag count — 0 lets pax alone drive the vehicle floor.
  // Every ride is the Ride shape now; a 2-stop Ride prices identically to the old {from,to,distanceKm}
  // (types.ts normalizeRide), which the pairwise test above pins at 8900.
  return runEngine({ product: 'private', vehicle, pax: input.pax, bags: 0, legs: legs.map((l) => l.ride) }, rateCard, discount);
}
```

- [ ] **Step 4: Run green** — `cd api && npx vitest run src/services/pricing.test.ts`. Expected: PASS including the pinned 8900 and the pre-existing chauffeur cases. If a pre-existing chauffeur case fails on label text (`A → B` vs the Ride's `stops.join(' → ')`), that is the engine naming a 2-stop Ride identically — read the failing diff before changing anything, and report if it is not a pure label match.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/pricing.ts api/src/services/pricing.test.ts
git commit -m "feat(pricing): group through wires into one ride when pricing a trip"
```

### Task 10: derive one leg row with `viaStops` for a through-run

**Files:**
- Modify: `api/src/domain/bookingLegs.ts:105-200`
- Test: `api/src/domain/bookingLegs.test.ts`

**Interfaces:**
- Produces: `deriveTripLegs(input: { stops; dates?; gaps?; through?; serviceType })`.

- [ ] **Step 1: Failing tests** — append to `api/src/domain/bookingLegs.test.ts`:

```ts
describe('deriveTripLegs — through (stops on the way)', () => {
  it('private: a through-run is one leg with viaStops, dated by its first wire', () => {
    const legs = deriveTripLegs({
      stops: ['Kandy', 'Pinnawala', 'Sigiriya', 'Ella'],
      dates: ['2026-12-01', '2026-12-01', '2026-12-03'],
      through: [0],
      serviceType: 'private',
    });
    expect(legs).toEqual([
      { seq: 1, kind: 'leg', fromPlace: 'Kandy', toPlace: 'Sigiriya', viaStops: ['Pinnawala'], travelDate: '2026-12-01', pickupTime: null },
      { seq: 2, kind: 'leg', fromPlace: 'Sigiriya', toPlace: 'Ella', viaStops: [], travelDate: '2026-12-03', pickupTime: null },
    ]);
  });

  it('private: a round trip through a stop is one leg from and to the same place', () => {
    const legs = deriveTripLegs({ stops: ['Kandy', 'Pinnawala', 'Kandy'], through: [0], serviceType: 'private' });
    expect(legs).toEqual([
      { seq: 1, kind: 'leg', fromPlace: 'Kandy', toPlace: 'Kandy', viaStops: ['Pinnawala'], travelDate: null, pickupTime: null },
    ]);
  });

  it('chauffeur: a through wire joins the day even when the trip has no dates at all', () => {
    const legs = deriveTripLegs({ stops: ['Kandy', 'Pinnawala', 'Sigiriya', 'Ella'], through: [0], serviceType: 'chauffeur' });
    expect(legs.map((l) => [l.kind, l.fromPlace, l.toPlace, l.viaStops])).toEqual([
      ['day', 'Kandy', 'Sigiriya', ['Pinnawala']],
      ['day', 'Sigiriya', 'Ella', []],
    ]);
  });
});
```

- [ ] **Step 2: Run red** — `cd api && npx vitest run src/domain/bookingLegs.test.ts -t "through"`. Expected: FAIL (`through` ignored; three/two rows instead of merged).

- [ ] **Step 3: Implement.** In `api/src/domain/bookingLegs.ts`:

```ts
export function deriveTripLegs(input: {
  stops: string[];
  dates?: string[] | null;
  gaps?: number[] | null;
  through?: number[] | null;
  serviceType: 'private' | 'chauffeur';
}): DerivedLeg[] {
  const { stops, serviceType } = input;
  const dates = input.dates ?? [];
  const through = new Set(input.through ?? []);
  if (stops.length < 2) return [];
  const rows =
    serviceType === 'chauffeur'
      ? chauffeurDays(stops, dates, through)
      : privateLegs(stops, dates, new Set(input.gaps ?? []), through);
  return rows.map((row, i) => ({ ...row, seq: i + 1 }));
}
```

Replace `privateLegs`:

```ts
// A through wire (0078_trip_request_through) continues the leg onto the next wire: stops[i+1] is
// a stop on the way. The run's date is its first wire's (the route handler refuses differing dates).
function privateLegs(stops: string[], dates: string[], gaps: Set<number>, through: Set<number>): Unsequenced[] {
  const out: Unsequenced[] = [];
  const lastWire = stops.length - 2;
  let i = 0;
  while (i <= lastWire) {
    if (gaps.has(i)) {
      out.push({ kind: 'gap', fromPlace: stops[i], toPlace: stops[i + 1], viaStops: [], travelDate: dates[i] || null, pickupTime: null });
      i += 1;
      continue;
    }
    let end = i;
    while (end < lastWire && through.has(end) && !gaps.has(end + 1)) end += 1;
    out.push({
      kind: 'leg',
      fromPlace: stops[i],
      toPlace: stops[end + 1],
      viaStops: stops.slice(i + 1, end + 1),
      travelDate: dates[i] || null,
      pickupTime: null,
    });
    i = end + 1;
  }
  return out;
}
```

In `chauffeurDays`, change the signature to `(stops: string[], dates: string[], through: Set<number>)`, replace the no-dates fallback with a through-aware grouping, and let a through wire extend a dated day:

```ts
  if (!dates.slice(0, stops.length - 1).some((d) => !!d)) {
    const out: Unsequenced[] = [];
    const lastWire = stops.length - 2;
    let i = 0;
    while (i <= lastWire) {
      let end = i;
      while (end < lastWire && through.has(end)) end += 1;
      out.push({ kind: 'day' as const, fromPlace: stops[i], toPlace: stops[end + 1], viaStops: stops.slice(i + 1, end + 1), travelDate: null, pickupTime: null });
      i = end + 1;
    }
    return out;
  }
```

and in the dated loop change `while (end < lastSegment && (dates[end + 1] || '') === date) end += 1;` to:

```ts
    while (end < lastSegment && (through.has(end) || (dates[end + 1] || '') === date)) end += 1;
```

- [ ] **Step 4: Run green** — `cd api && npx vitest run src/domain/bookingLegs.test.ts src/db/postgresBookingRepo.legs.test.ts src/db/checkBookingLegs.test.ts`. Expected: PASS (every pre-existing case too — `through` defaults to empty).

- [ ] **Step 5: Commit**

```bash
git add api/src/domain/bookingLegs.ts api/src/domain/bookingLegs.test.ts
git commit -m "feat(legs): merge a through-run into one booking leg with viaStops"
```

### Task 11: store and read `through`; backfill script

**Files:**
- Modify: `api/src/db/postgresBookingRepo.ts:284-287`, `:512-514`; `api/scripts/backfill-booking-legs.ts:37`, `:79`, `:122`
- Create: `api/src/db/postgresBookingRepo.through.test.ts`

- [ ] **Step 1: Failing DB round-trip test** (skips without `DATABASE_URL_TEST`, one pool for the describe — memory "one pool per describe"):

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { PostgresBookingRepo } from './postgresBookingRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;
const customer = { firstName: 'Via', lastName: 'Test', email: 'via@example.com', whatsapp: '+94770000001', country: 'LK' };

describe.skipIf(!TEST_URL)('trip_request.through round-trips and derives viaStops (integration)', () => {
  let bookings: PostgresBookingRepo;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    const sql = postgres(TEST_URL as string);
    db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(db);
  });

  it('stores through, reads it back, and writes one booking_legs row with via_stops', async () => {
    const nb: NewBooking = {
      mode: 'trip', total: 1000, amountDueNow: 1000, currency: 'USD',
      input: { stops: ['Kandy', 'Pinnawala', 'Sigiriya'], nights: [0, 0, 0], pax: 1, vehicleType: 'car', serviceType: 'private', through: [0], customer },
    };
    const created = await bookings.create(nb);
    const back = await bookings.get(created.id);
    expect(back?.mode).toBe('trip');
    expect((back!.input as { through?: number[] }).through).toEqual([0]);
    const legs = await db.select().from(schema.bookingLegs).where(eq(schema.bookingLegs.bookingId, created.id));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ fromPlace: 'Kandy', toPlace: 'Sigiriya', viaStops: ['Pinnawala'] });
  });

  it('leaves a booking without through byte-identical: no key on read-back', async () => {
    const created = await bookings.create({
      mode: 'trip', total: 1000, amountDueNow: 1000, currency: 'USD',
      input: { stops: ['Kandy', 'Ella'], nights: [0, 0], pax: 1, vehicleType: 'car', serviceType: 'private', customer },
    });
    const back = await bookings.get(created.id);
    expect(back!.input).not.toHaveProperty('through');
  });
});
```

- [ ] **Step 2: Run red** — `cd api && DATABASE_URL_TEST=<your test url> npx vitest run src/db/postgresBookingRepo.through.test.ts`. Expected: FAIL (`through` undefined on read-back; one `viaStops: []` row per pair).

- [ ] **Step 3: Implement.** `postgresBookingRepo.ts` read branch (after the `gaps` line):

```ts
        // Same rule for wires that continue the leg (0078_trip_request_through).
        ...(tr.through?.length ? { through: tr.through } : {}),
```

insert (after `gaps:`):

```ts
          through: t.through?.length ? t.through : null,
```

`api/scripts/backfill-booking-legs.ts`: add `through?: number[]` to the `trip?` type at line 37, `...(trip.through?.length ? { through: trip.through } : {})` beside the gaps spread at line 79, and `through: row.trip.through,` beside `gaps:` at line 122.

- [ ] **Step 4: Run green** — same command, plus `cd api && npm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add api/src/db/postgresBookingRepo.ts api/src/db/postgresBookingRepo.through.test.ts api/scripts/backfill-booking-legs.ts
git commit -m "feat(db): persist trip_request.through and derive viaStops from it"
```

### Task 12: a multi-stop ops/web quote converts with `through`

**Files:**
- Modify: `api/src/quote/quoteToBooking.ts:40-63` (`chainStops`), `:132-160` (private branch)
- Test: `api/src/quote/quoteToBooking.test.ts`

- [ ] **Step 1: Failing test** — extend the Task 4 test (same fixture names):

```ts
  it('marks every segment inside a 3+-stop ride as through, so the booking keeps it as one leg', () => {
    const q = savedPrivateQuote({ legs: [
      { stops: ['Kandy', 'Pinnawala', 'Sigiriya'], segmentKms: [40, 70] },
      { from: 'Sigiriya', to: 'Ella', distanceKm: 180 },
    ] });
    const out = quoteToBooking(q, details);
    expect(out.input).toMatchObject({ stops: ['Kandy', 'Pinnawala', 'Sigiriya', 'Ella'], through: [0] });
  });
```

- [ ] **Step 2: Run red** — `cd api && npx vitest run src/quote/quoteToBooking.test.ts`. Expected: FAIL (`through` missing).

- [ ] **Step 3: Implement.** In `chainStops`, also return `through`: a segment is through when it and the next segment belong to the same ride.

```ts
function chainStops(rides: Ride[]): { stops: string[]; rideIndex: number[]; through: number[] } {
  const stops = [...rides[0].stops];
  const rideIndex: number[] = rides[0].stops.slice(1).map(() => 0);
  rides.slice(1).forEach((ride, i) => {
    if (ride.stops[0] !== stops[stops.length - 1]) {
      stops.push(ride.stops[0]); // the gap: a stop we don't drive to/from the previous one
      rideIndex.push(-1);
    }
    for (const stop of ride.stops.slice(1)) {
      stops.push(stop);
      rideIndex.push(i + 1);
    }
  });
  // Segment k continues onto k+1 when both belong to the same ride (a 3+-stop ride's inner stops).
  const through = rideIndex.flatMap((r, k) => (r >= 0 && rideIndex[k + 1] === r ? [k] : []));
  return { stops, rideIndex, through };
}
```

In the private branch, destructure `through` and add it to `input` beside `gaps`:

```ts
    const { stops, rideIndex, through } = chainStops(rides);
    …
        ...(gaps.length ? { gaps } : {}),
        ...(through.length ? { through } : {}),
```

In the chauffeur branch, destructure the same and add `...(through.length ? { through } : {})` to its `input` (its day grouping by date already merges, but the column should say so too).

- [ ] **Step 4: Run green** — `cd api && npx vitest run src/quote/quoteToBooking.test.ts src/quote/goldens.test.ts src/routes/quoteConversion.test.ts`. Expected: PASS. A golden that snapshots a converted multi-stop booking may now show `through` — if so the golden gains the key; confirm the diff is only that key before updating it.

- [ ] **Step 5: Commit**

```bash
git add api/src/quote/quoteToBooking.ts api/src/quote/quoteToBooking.test.ts
git commit -m "feat(quote): a multi-stop ride converts to a booking with through wires"
```

### Task 13: gate and PR

- [ ] `cd api && DATABASE_URL_TEST=<test url> npm run check` — Expected: all green, exit 0.
- [ ] Open PR `feat/trip-through → main` titled "feat(trip): through wires — stops on the way inside a leg (PR 2/4, migration 0078)". Body: spec §4.2, **"Contains migration 0078 (nullable column add). Applies to staging on merge; prod on the next promote. Owner OK required."**, red→green from Tasks 6–12.

---

# Part C — PR 3: booking page carries and shows stops

Branch: `feat/booking-stops`. Needs PR 2 merged (sends `through`), and PR 1 for live pricing of via legs (estimate stub covers it in tests).

### Task 14: parse `through` and `ack`, run-aware trip legs

**Files:**
- Modify: `booking.js:91` (state), `:180-205` (parse), `:148-176` (`tripQuoteWithKms`), `:728-748` (summary render), `:1774-1776` (`tripRoadAt`)
- Test: `web-tests/e2e/booking-trip-stops.spec.js`

**Interfaces:**
- Produces: `tripThrough: Set<number>`, `tripAcks: Set<number>` (leg indexes, 0-based over priced legs), `tripRunOf(i) → { head: number, wires: number[], stops: string[] }`, `tripIsCont(i) → boolean`. `tripLegs[i]` stays **per wire**; a continuation wire gets `{ cont: true }` and no price; the head wire carries `via: string[]` and the summed km/price.

- [ ] **Step 1: Failing e2e** — create `web-tests/e2e/booking-trip-stops.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact, fillBilling } from './_stubs.js';

// A planner leg with a stop on the way arrives as a flat ?stops= chain plus `through` (the wires
// that continue the same leg). The page must show it as ONE leg, price it as one, send `via` on the
// estimate and `through` on the booking — never as two legs.
const Q = 'mode=trip&stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Ella') + '&nights=0,0,0&dates=,&through=0&pax=2&vehicle=car';

test('one leg card for a through-run, titled with the whole chain', async ({ page }) => {
  await gotoBooking(page, { query: Q });
  await expect(page.locator('.tr-leg-badge')).toHaveCount(1);
  await expect(page.locator('.tr-leg-title').first()).toContainText('Kandy');
  await expect(page.locator('.tr-leg-title').first()).toContainText('Sigiriya');
  await expect(page.locator('.tr-leg-title').first()).toContainText('Ella');
  await expect(page.locator('.tr-via')).toHaveCount(1);
});

test('the estimate carries via; the booking carries through', async ({ page }) => {
  const estimates = [];
  await page.route('**/quote/v2/estimate', async (r) => {
    estimates.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      totalCents: 9900, amountDueNowCents: 9900, estimated: false,
      legs: [{ from: 'Kandy', to: 'Ella', via: ['Sigiriya / Dambulla'], distanceKm: 270, durationMin: 390 }],
    }) });
  });
  const { bookingBodies } = await gotoBooking(page, { query: Q, captureBooking: true });
  await expect.poll(() => estimates.length).toBeGreaterThan(0);
  expect(estimates[estimates.length - 1].legs).toEqual([{ from: 'Kandy', to: 'Ella', via: ['Sigiriya / Dambulla'] }]);
  await fillContact(page);
  await fillBilling(page);
  await page.locator('#pay-btn').click();
  await expect.poll(() => bookingBodies.length).toBe(1);
  expect(bookingBodies[0].through).toEqual([0]);
  expect(bookingBodies[0].stops).toEqual(['Kandy', 'Sigiriya / Dambulla', 'Ella']);
});

test('a kept long day is written into the customer notes for ops', async ({ page }) => {
  const { bookingBodies } = await gotoBooking(page, { query: Q + '&ack=0', captureBooking: true });
  await fillContact(page);
  await fillBilling(page);
  await page.locator('#pay-btn').click();
  await expect.poll(() => bookingBodies.length).toBe(1);
  expect(bookingBodies[0].customerNotes).toMatch(/Planner: kept a .* day \(Kandy → Sigiriya \/ Dambulla → Ella\)/);
});
```

If `gotoBooking` has no `captureBooking` option, add one in `_stubs.js`: inside its `POST /bookings/*` route handler push `JSON.parse(route.request().postData())` onto a `bookingBodies` array that the function returns (it already returns `checkoutBodies` the same way — copy that pattern). Confirm the pay button id with `grep -n 'id="pay-btn"' booking.html`; if it differs, use the real id.

- [ ] **Step 2: Run red** — `cd web-tests && npx playwright test booking-trip-stops`. Expected: FAIL (two `.tr-leg-badge`, no `via`, no `through`).

- [ ] **Step 3: Implement** in `booking.js`.

State (line 91): add `tripThrough=new Set(), tripAcks=new Set()` to the `let` list.

Parse (after `tripGaps=…`, line 188):

```js
  tripThrough=new Set((params.get('through')||'').split(',').map(n=>parseInt(n,10)).filter(n=>!isNaN(n)));
  tripAcks=new Set((params.get('ack')||'').split(',').map(n=>parseInt(n,10)).filter(n=>!isNaN(n)));
```

Helpers (above `tripQuoteWithKms`):

```js
// A through wire continues the leg onto the next wire (spec 2026-10-30 §4.3): the run that starts
// at `head` owns every wire up to the first non-through one. tripLegs stays indexed PER WIRE so
// nothing that reads tripLegs[i] by data-wire changes; a continuation wire is marked `cont`.
function tripIsCont(i){ return i>0 && tripThrough.has(i-1) && !tripGaps.has(i); }
function tripRunOf(i){
  let head=i; while(tripIsCont(head)) head--;
  const wires=[head]; let w=head;
  while(tripThrough.has(w) && w+1<tripStops.length-1 && !tripGaps.has(w+1)){ w++; wires.push(w); }
  return { head, wires, stops:[tripStops[head]].concat(wires.map(x=>tripStops[x+1])) };
}
```

In `tripQuoteWithKms`, change the early return guard to also walk the loop when `tripThrough.size`, and replace the per-wire body after the gap check with:

```js
    if(tripIsCont(i)){ legs.push({ from:tripStops[i], to:tripStops[i+1], cont:true, km:null, price:0 }); continue; }
    const run=tripRunOf(i);
    const bakedLeg=baked.legs[i]||{from:tripStops[i],to:tripStops[i+1],km:null,duration:'',price:55,est:true};
    // A run's km is the sum over its wires — or null while ANY wire is unmeasured (a partial sum
    // would price part of a route as the whole leg; ops legKm has the same rule).
    let km=0;
    for(const w of run.wires){ const k=tripKms[w]!=null ? tripKms[w] : (w===i ? bakedLeg.km : null); if(k==null){ km=null; break; } km+=k; }
    let price, est=false;
    if(km!=null){ price=T.legPrice(km, veh); totalKm+=km; }
    else { price=(bakedLeg.price!=null ? bakedLeg.price : 55); est=true; hasEst=true; }
    total+=price;
    legs.push({
      from:run.stops[0],
      to:run.stops[run.stops.length-1],
      via:run.stops.slice(1,-1),
      km,
      duration:km!=null ? T.durationText(km) : bakedLeg.duration,
      price,
      est,
    });
```

Summary render (line 734): skip continuation wires and show the chain:

```js
    if(leg.cont) return;
    const viaHtml=(leg.via&&leg.via.length) ? `<span class="tr-via"> <span class="tr-ar">→</span> ${leg.via.map(escHtml).join(' <span class="tr-ar">→</span> ')}</span>` : '';
    html+=`<div class="tr-leg" data-wire="${i}">`+
      `<div class="tr-leg-main"><span class="tr-leg-badge">Leg ${++_legNo}</span><span class="tr-leg-title">${escHtml(leg.from)}${viaHtml} <span class="tr-ar">→</span> ${escHtml(leg.to)}</span></div>`+
```

`tripRoadAt` (line 1774): a wire inside a run has no road:

```js
function tripRoadAt(i){ return (state.svc==='chauffeur' || tripGaps.has(i) || tripThrough.has(i) || tripIsCont(i)) ? 'fastest' : (tripRoads[i]||'fastest'); }
```

Estimate write-back loop (line ~1803): the API returns one leg per *run*, so advance `j` only on run heads — change `if(tripGaps.has(i)) continue;` to `if(tripGaps.has(i) || tripIsCont(i)) continue;`.

- [ ] **Step 4: Run** the first spec only — `cd web-tests && npx playwright test booking-trip-stops -g "one leg card"`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add booking.js web-tests/e2e/booking-trip-stops.spec.js web-tests/e2e/_stubs.js
git commit -m "feat(booking): show a through-run as one leg with its stops"
```

### Task 15: send `via` on the estimate, `through` on the booking, the ack note, and the edit link

**Files:**
- Modify: `booking.js:1843-1849` (intent), `:3427-3453` (lock legs + payload), `:749` (`tripEditQuery`)

- [ ] **Step 1: Intent builder** (line 1843) — one leg per run head:

```js
    const legs = [];
    for(let i=0;i<tripStops.length-1;i++){
      if(tripGaps.has(i) || tripIsCont(i)) continue;
      const run=tripRunOf(i);
      const leg={ from: run.stops[0], to: run.stops[run.stops.length-1] };
      if(run.stops.length>2) leg.via=run.stops.slice(1,-1);           // sent only when non-empty (fingerprint rule)
      else if(tripRoadAt(i)==='no_tolls') leg.routeVariant='no_tolls';  // a chain has no road choice
      legs.push(leg);
    }
    return { product:'private', vehicle, pax, bags, legs, extras };
```

Chauffeur branch (line 1835): same run logic — skip `tripIsCont(i)`, build `{ date, from, to }` from the run and add `via` when `run.stops.length>2`.

- [ ] **Step 2: Lock legs + payload** (line 3427): the `tripLegs` built for `ensureLockedQuoteId` must use the same run logic with `via`; add to `payload`:

```js
      through: tripThrough.size ? [...tripThrough].sort((a,b)=>a-b) : undefined,
```

Then, after `payload` is built in the trip branch, append the acknowledgement line. Find where `customerNotes` is attached to the payload (`grep -n "customerNotes" booking.js` — it is set once for every mode from the notes textarea); directly after that assignment add:

```js
  if(isTrip && tripAcks.size){
    const lines=[...tripAcks].sort((a,b)=>a-b).map(h=>{
      const run=tripRunOf(h), leg=tripLegs[h];
      const hrs=leg && leg.km!=null ? Math.round(leg.km/42) : null;
      const when=(tripDates[h]||'').trim();
      return 'Planner: kept a '+(hrs!=null?hrs+' h':'long')+' day ('+run.stops.join(' → ')+')'+(when?', '+when:'');
    });
    payload.customerNotes=[payload.customerNotes||'', ...lines].filter(Boolean).join('\n');
  }
```

(`km/42` is the planner's `drivingMinutes` model, `plan.js:170`.)

- [ ] **Step 3: Edit link** (line 749): add `through:[...tripThrough].join(',')` and `ack:[...tripAcks].join(',')` to the `URLSearchParams` so "Edit" returns the stops to the planner.

- [ ] **Step 4: Run green** — `cd web-tests && npx playwright test booking-trip-stops`. Expected: 3 passed.

- [ ] **Step 5: Stamp, full gate, commit**

```bash
npm run stamp
cd web-tests && npm run test:all
```
Expected: vitest summary all passed; Playwright "N passed" (existing booking specs included), exit 0.

```bash
git add booking.js web-tests/e2e/booking-trip-stops.spec.js $(git diff --name-only | grep -E '\.html$|site\.css$')
git commit -m "feat(booking): send via on the estimate and through on the booking; note a kept long day"
```

### Task 16: PR

- [ ] Verify in the browser pane (`preview_start` `ceylon-hop-booking`, open `booking.html?` + the spec's `Q`) at 375 × 812, 768 × 1024 and 1280 × 800: one leg card, chain in the title, no horizontal scroll. Screenshot each.
- [ ] Open PR `feat/booking-stops → main` "feat(booking): carry and show stops on the way (PR 3/4)" with red→green and the three screenshots.

---

# Part D — PR 4: the planner

Branch: `feat/planner-stops`. Needs PR 1 (live pricing of via legs via `/quote/v2/estimate-batch` only for catalogue chains; everything else is local) and PR 3 (booking reads `through`/`ack`).

**ch-map note (owner decision, spec §3.3):** `ch-map.js` is shared with booking and the trip pages. A round trip (Kandy → Pinnawala → Kandy) will draw two pins on Kandy. Merging them is a `ch-map.js` change — out of this PR; raise it as its own one-line proposal when PR 4 opens. The SVG fallback below dedups by name.

**Kill switch:** `const PLANNER_STOPS = true;` at the top of `plan.js`. Off → no add-stop link, legs with `via` in the URL load with their stops collapsed into separate legs (`buildLegs` ignores `through`). One e2e asserts the off state. Flipping it is a one-line PR.

**Selectors contract (tests and CSS use these names):** `.leg-via` (stop input), `.rb-field.via`, `.stop-ctl`, `.stop-swap`, `.stop-rm`, `.add-via`, `.leg-warn` with `.long-day` or `.stop` modifiers, `.dw-split`, `.dw-keep`, `#route-incomplete-hint` (reused for both Next hints).

### Task 17: state, URL and hand-off (`through`, `ack`)

**Files:**
- Modify: `plan.js:201-213` (params), `:214-232` (`buildLegs`), `:481-535` (`routeSeq`, `routeSeqDetailed`), `:536-555` (`syncPlanUrl`), `:1633-1656` (`goToBooking`)
- Test: `web-tests/e2e/plan-stops.spec.js` (first cases)

**Interfaces:**
- Produces: `state.legs[i].via: string[]`, `state.legs[i].ack: 'long_day' | null`; `legChain(leg) → string[]`; `routeSeqDetailed()` returns `through: number[]`; URL/hand-off params `through=<wire idx>`, `ack=<leg idx>`.

- [ ] **Step 1: Failing e2e** — create `web-tests/e2e/plan-stops.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
  { name: 'tablet', viewport: { width: 768, height: 1024 } },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});

const CHAIN = 'Kandy|Sigiriya / Dambulla|Ella';
const url = (extra = '') => '/plan.html?stops=' + encodeURIComponent(CHAIN) + '&nights=0,0,0&through=0&pax=2&vehicle=car' + extra;

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile });

    test('loads a through wire as one leg with a stop row', async ({ page }) => {
      await page.goto(url());
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveValue('Sigiriya / Dambulla');
      await expect(page.locator('#st-stops')).toHaveText('3');
      await expect(page.locator('#st-legs')).toHaveText('1');
      await expect(page.locator('#sum-route')).toContainText('Kandy');
      await expect(page.locator('#sum-route')).toContainText('Ella');
      // no horizontal overflow at this width
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(over).toBe(false);
    });

    test('hands the stop to booking as through, and back again on edit', async ({ page }) => {
      await page.goto(url());
      await page.locator('#request-btn').click();
      await page.locator('#dates-continue').click();
      await page.waitForURL('**/booking.html?**');
      const q = new URL(page.url()).searchParams;
      expect(q.get('stops')).toBe(CHAIN);
      expect(q.get('through')).toBe('0');
      await page.locator('.tr-edit').click();
      await page.waitForURL('**/plan.html?**');
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveCount(1);
    });
  });
}

test('kill switch off: the same URL loads as two plain legs and offers no add-stop link', async ({ page }) => {
  await page.addInitScript(() => { window.__CH_PLANNER_STOPS_OFF = true; });
  await page.goto(url());
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await expect(page.locator('.add-via')).toHaveCount(0);
});
```

- [ ] **Step 2: Run red** — `cd web-tests && npx playwright test plan-stops`. Expected: FAIL (2 cards, no `.leg-via`).

- [ ] **Step 3: Implement** in `plan.js`.

Top of file (after the header comment):

```js
// Stops on the way inside one leg (spec 2026-10-30-planner-stops-within-a-leg-design.md). One
// constant turns the feature off: no add-stop link, and a `through` URL loads as separate legs.
const PLANNER_STOPS = !window.__CH_PLANNER_STOPS_OFF;
```

Params (after `gapsParam`, line ~208):

```js
const throughParam = PLANNER_STOPS ? (params.get('through')||'').split(',').map(n=>parseInt(n,10)).filter(n=>!isNaN(n)) : [];
const ackParam = (params.get('ack')||'').split(',').map(n=>parseInt(n,10)).filter(n=>!isNaN(n));
```

`buildLegs(stops, nights, gaps, through)`: replace the transfer push inside the loop so a through-run becomes one leg:

```js
function buildLegs(stops, nights, gaps, through){
  const hasNights = nights && nights.some(n=>n>0);
  if(!stops.length) return [];
  if(stops.length<2) return [{ type:'transfer', from:stops[0]||'', to:'', date:null, nights:1, via:[], ack:null }];
  const isGap = new Set(gaps||[]);
  const isThrough = new Set(through||[]);
  const N = i => (nights && nights[i]>0) ? nights[i] : 0;
  const legs=[];
  if(hasNights && N(0)>0) legs.push({ type:'stay', from:stops[0], to:stops[0], date:null, nights:N(0) });
  let i=0;
  while(i<stops.length-1){
    if(isGap.has(i)){ i++; continue; }
    // a through wire continues this leg onto the next wire: stops[i+1] is a stop on the way
    let end=i; while(end<stops.length-2 && isThrough.has(end) && !isGap.has(end+1)) end++;
    legs.push({ type:'transfer', from:stops[i], to:stops[end+1], via:stops.slice(i+1,end+1), date:null, nights:1, ack:null });
    for(let k=end+1;k<=end+1;k++) if(hasNights && k<stops.length-1 && N(k)>0) legs.push({ type:'stay', from:stops[k], to:stops[k], date:null, nights:N(k) });
    i=end+1;
  }
  return legs;
}
```

and the state line: `legs: buildLegs(startStops, nightsParam, gapsParam, throughParam),`. After state is built, mark acks: `ackParam.forEach(i=>{ const t=state.legs.filter(l=>l.type!=='stay')[i]; if(t) t.ack='long_day'; });`. Every other `state.legs.push({ type:'transfer', … })` in the file (add-transfer button, line 435; the split action in Task 21) gets `via:[], ack:null`.

Helper (near `liveRouteKey`):

```js
// The ordered places a transfer drives through: pick-up, each stop on the way, drop-off.
function legChain(leg){ return [leg.from||''].concat(leg.via||[], [leg.to||'']); }
```

`routeSeq()`: in the transfer branch replace `addPlace(l.from||'',0); addPlace(l.to||'',0);` with `legChain(l).forEach(p=>addPlace(p,0));`.

`routeSeqDetailed()`: replace the transfer branch so every wire of the chain is claimed, measured per pair, and inner wires are `through`:

```js
    else {
      const chain=legChain(l);
      const first=seq.length; // seq index of this leg's pick-up once added (or merged into the previous place)
      chain.forEach(p=>addPlace(p,0));
      const wiresHere=[];
      for(let k=0;k<chain.length-1;k++){
        const w=seq.length-(chain.length-1)+k; // wire between chain[k] and chain[k+1] in seq space
        if(w<0) continue;
        claimed.add(w);
        wires[w] = l.date ? fmtISO(l.date) : '';
        const route=legRouteEstimate(chain[k],chain[k+1]);
        const km=route ? route.distanceKm : null;
        wireKm[w] = km!=null ? String(km) : '';
        wireRoad[w] = route && route.road==='no_tolls' ? 'no_tolls' : '';
        wireChosen[w] = roadChoice.get(liveRouteKey(chain[k],chain[k+1]))==='no_tolls' ? 'no_tolls' : '';
        wiresHere.push(w);
      }
      wiresHere.slice(0,-1).forEach(w=>throughSet.add(w)); // every wire but the last continues the leg
    }
```

Declare `const throughSet=new Set();` beside `claimed`, and return `through:[...throughSet].sort((a,b)=>a-b)` in the result object. The `seq.length>=2` guard from the old code is replaced by `w<0`.

Note on merged places: `addPlace` merges a place equal to the previous one (`Kandy → Kandy` across two legs). A chain never has consecutive equal places once Task 20's hard stop is in force, so the wire arithmetic above holds; a round trip Kandy → Pinnawala → Kandy is fine (not consecutive).

`syncPlanUrl()`: `const { seq, dates, gaps, chosenRoads, through } = routeSeqDetailed();` and `if(through.length) p.set('through', through.join(',')); else p.delete('through');` plus `const acks=state.legs.filter(l=>l.type!=='stay').map((l,i)=>l.ack?i:-1).filter(i=>i>=0); if(acks.length) p.set('ack',acks.join(',')); else p.delete('ack');`.

`goToBooking()`: destructure `through` too and add `if(through.length) p.set('through', through.join(','));` and the same `ack` line after `roads`.

- [ ] **Step 4: Run** — `cd web-tests && npx playwright test plan-stops -g "loads a through wire|hands the stop|kill switch"`. Expected: the "loads" tests still FAIL on `.leg-via` (no row rendered yet — Task 18), the kill-switch test PASSES, the hand-off test FAILS until Task 18. That is expected; continue.

- [ ] **Step 5: Commit**

```bash
git add plan.js web-tests/e2e/plan-stops.spec.js
git commit -m "feat(plan): leg state carries stops on the way; through/ack round-trip the URL and the hand-off"
```

### Task 18: stop rows, hover controls, add-stop link (card + CSS)

**Files:**
- Modify: `plan.html` style block (after `.rb-swap svg{…}`, line ~236), `plan.js:874-890` (`transferBody`), `:922-947` (wiring)
- Test: `web-tests/e2e/plan-stops.spec.js`

- [ ] **Step 1: Failing e2e** — append inside the per-viewport describe:

```js
    test('adds a stop on the way, prices the whole chain, and removes it again', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card.locator('.add-via')).toHaveText(/Add a stop on the way/);
      await card.locator('.add-via').click();
      const via = card.locator('.leg-via');
      await expect(via).toBeFocused();
      await via.fill('Sigiriya');
      await expect(page.locator('.place-menu')).toBeVisible();
      await page.locator('.place-option', { hasText: 'Sigiriya' }).first().click();
      await expect(card.locator('.add-via')).toHaveText(/Add another stop/);
      await expect(card.locator('.leg-meta')).toContainText('km');
      await expect(page.locator('#st-stops')).toHaveText('3');
      await expect(page.locator('#st-legs')).toHaveText('1');
      // controls: hover (or always, on touch) shows swap + remove on every row
      const dropRow = card.locator('.rb-field').last();
      await dropRow.hover();
      await expect(dropRow.locator('.stop-swap')).toBeVisible();
      await expect(dropRow.locator('.stop-rm')).toBeVisible();
      // remove the stop → back to a plain leg
      const viaRow = card.locator('.rb-field.via');
      await viaRow.hover();
      await viaRow.locator('.stop-rm').click();
      await expect(card.locator('.leg-via')).toHaveCount(0);
      await expect(card.locator('.stop-rm')).toHaveCount(0); // a two-place leg has no ×
      await expect(page.locator('#st-stops')).toHaveText('2');
    });

    test('⇅ on a row swaps it with the row below; on the last row, with the row above', async ({ page }) => {
      await page.goto(url());
      const card = page.locator('#rail .leg-card').first();
      const rows = card.locator('.rb-field');
      await rows.nth(0).hover();
      await rows.nth(0).locator('.stop-swap').click();
      await expect(card.locator('.leg-from')).toHaveValue('Sigiriya / Dambulla');
      await expect(card.locator('.leg-via')).toHaveValue('Kandy');
      await rows.nth(2).hover();
      await rows.nth(2).locator('.stop-swap').click();
      await expect(card.locator('.leg-via')).toHaveValue('Ella');
      await expect(card.locator('.leg-to')).toHaveValue('Kandy');
    });

    test('a stay card has no add-stop link; the cap hides it at 4 stops', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&nights=1,0&pax=2&vehicle=car');
      await expect(page.locator('.leg.is-stay .add-via')).toHaveCount(0);
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Anuradhapura|Trincomalee|Ella|Galle') + '&nights=0,0,0,0,0,0&through=0,1,2,3&pax=2&vehicle=car');
      await expect(page.locator('#rail .leg-via')).toHaveCount(4);
      await expect(page.locator('.add-via')).toHaveCount(0);
    });
```

- [ ] **Step 2: Run red** — `cd web-tests && npx playwright test plan-stops`. Expected: FAIL (no `.add-via`).

- [ ] **Step 3: CSS** — add to `plan.html`'s style block after `.rb-swap svg{…}` (keep the old `.rb-swap` rules; they are no longer rendered but harmless until a cleanup PR):

```css
  /* stops on the way (spec 2026-10-30): a stop is a row on the same rail */
  .rb-pin.via{width:10px;height:10px;border:none;background:var(--teal-deep);margin:1px}
  .rb-field{display:flex;align-items:center;gap:8px}
  .rb-field>.rb-f{flex:1;min-width:0}
  .rb-field.via label{color:var(--teal-deep)}
  .stop-ctl{flex:none;display:inline-flex;gap:6px;opacity:0;transition:opacity .15s}
  .rb-field:hover .stop-ctl,.rb-field:focus-within .stop-ctl{opacity:1}
  @media(hover:none){.stop-ctl{opacity:1}}
  @media(prefers-reduced-motion:reduce){.stop-ctl{transition:none}}
  .stop-swap,.stop-rm{flex:none;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--line);background:var(--white);display:grid;place-items:center;cursor:pointer;color:var(--ink-soft)}
  .stop-swap{color:var(--accent-deep)}
  .stop-swap:hover{border-color:var(--accent)}
  .stop-rm:hover{border-color:var(--tomato);color:var(--tomato)}
  .stop-swap svg,.stop-rm svg{width:11px;height:11px}
  .leg-foot.stops{justify-content:flex-end;margin-top:8px}
  .add-via{display:inline-flex;align-items:center;gap:.4rem;background:none;border:none;color:var(--accent-deep);font-family:inherit;font-weight:700;font-size:.82rem;padding:4px 2px;cursor:pointer;border-radius:6px}
  .add-via:hover{text-decoration:underline}
  .add-via:focus-visible{outline:2px solid var(--btn-accent,#24758A);outline-offset:2px}
  .add-via svg{width:14px;height:14px}
  .add-via[disabled]{color:var(--ink-soft);opacity:.6;cursor:default;text-decoration:none}
  .rb-divider.plain .rb-swap{display:none}
```

The `.rb-field input` rule already exists; wrap the label+input in `<div class="rb-f">` (below) so the flex row keeps the input full-width.

- [ ] **Step 4: Card markup** — replace `transferBody` in `render()`:

```js
    const SWAP_ICO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg>';
    const X_ICO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    const via = PLANNER_STOPS ? (leg.via||[]) : [];
    const chainLen = via.length+2;
    // every row gets ⇅; × only when the leg has more than two places (a leg needs two)
    const ctl = (k) => `<span class="stop-ctl"><button type="button" class="stop-swap" data-k="${k}" aria-label="${k===chainLen-1?'Swap with the place above':'Swap with the place below'}" title="Swap">${SWAP_ICO}</button>${chainLen>2?`<button type="button" class="stop-rm" data-k="${k}" aria-label="Remove this place" title="Remove">${X_ICO}</button>`:''}</span>`;
    const rails = ['<span class="rb-pin from"></span>'].concat(via.map(()=>'<span class="rb-wire"></span><span class="rb-pin via"></span>'), ['<span class="rb-wire"></span><span class="rb-pin to"></span>']).join('');
    const viaRows = via.map((v,k)=>`
            <div class="rb-divider plain"></div>
            <div class="rb-field via" data-k="${k+1}"><div class="rb-f"><label>Stop on the way</label>
              <input class="leg-via place-input" required placeholder="Where do you want to stop?" data-k="${k+1}" value="${escAttr(v)}"></div>${ctl(k+1)}</div>`).join('');
    const transferBody = `
        <div class="route-block">
          <div class="rb-rail">${rails}</div>
          <div class="rb-fields">
            <div class="rb-field" data-k="0"><div class="rb-f"><label>Pick-up</label>
              <input class="leg-from place-input" required placeholder="Choose a place…" value="${escAttr(leg.from)}"></div>${ctl(0)}</div>
            ${viaRows}
            <div class="rb-divider plain"></div>
            <div class="rb-field" data-k="${chainLen-1}"><div class="rb-f"><label>Drop-off</label>
              <input class="leg-to place-input" required placeholder="Where to next…" value="${escAttr(leg.to)}"></div>${ctl(chainLen-1)}</div>
          </div>
        </div>
        ${PLANNER_STOPS ? `<div class="leg-foot stops"><button type="button" class="add-via" ${via.length>=4?'hidden':''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>${via.length?'Add another stop':'Add a stop on the way'}</button></div>` : ''}`;
```

- [ ] **Step 5: Wiring** — in the `if(!isStay)` block, replace the `[fromI,toI].forEach(wirePlaceSearch)` line (above the block) with `wrap.querySelectorAll('.place-input').forEach(wirePlaceSearch);`, and replace the swap handler with:

```js
      // chain helpers: k indexes [from, ...via, to]
      const getChain=()=>legChain(state.legs[i]);
      const setChain=(c)=>{ state.legs[i].from=c[0]; state.legs[i].to=c[c.length-1]; state.legs[i].via=c.slice(1,-1); state.legs[i].ack=null; };
      wrap.querySelectorAll('.leg-via').forEach(inp=>{
        const k=+inp.dataset.k;
        inp.addEventListener('input',()=>{ markRouteCustomized(); state.legs[i].via[k-1]=inp.value; recompute(); });
        inp.addEventListener('change',()=>{ markRouteCustomized(); state.legs[i].via[k-1]=inp.value; state.legs[i].ack=null; renderAfterPress(); });
      });
      wrap.querySelectorAll('.stop-swap').forEach(btn=>btn.addEventListener('click',()=>{
        markRouteCustomized();
        const c=getChain(), k=+btn.dataset.k, j=(k===c.length-1)?k-1:k+1;
        [c[k],c[j]]=[c[j],c[k]]; setChain(c); render();
      }));
      wrap.querySelectorAll('.stop-rm').forEach(btn=>btn.addEventListener('click',()=>{
        markRouteCustomized();
        const c=getChain(); if(c.length<=2) return;
        c.splice(+btn.dataset.k,1); setChain(c); render();
      }));
      const addVia=wrap.querySelector('.add-via');
      if(addVia) addVia.addEventListener('click',()=>{
        if((state.legs[i].via||[]).length>=4) return;
        markRouteCustomized();
        state.legs[i].via=(state.legs[i].via||[]).concat(['']); state.legs[i].ack=null; render();
        const c=document.querySelector(`#rail .leg-card[data-i="${i}"]`);
        const inputs=c?c.querySelectorAll('.leg-via'):[]; const last=inputs[inputs.length-1];
        if(last){ last.dataset.suppressMenu='1'; last.focus({ preventScroll:true }); }
      });
```

In `recompute()`, change the two state assignments to keep via in sync and price the chain (Task 19 replaces `legRouteEstimate(from,to)` with the chain version; for now leave the call and accept that a via leg shows the from→to figure until then).

- [ ] **Step 6: Stamp and run** — `npm run stamp && cd web-tests && npx playwright test plan-stops`. Expected: "adds a stop" FAILS only on `.leg-meta` km (chain pricing lands in Task 19); the swap, stay/cap and loads tests PASS. Hand-off test PASSES.

- [ ] **Step 7: Commit**

```bash
git add plan.html plan.js web-tests/e2e/plan-stops.spec.js $(git diff --name-only | grep -E '\.html$')
git commit -m "feat(plan): stop rows on the leg rail with hover swap/remove and an add-stop link"
```

### Task 19: measure and price the chain per segment; clear the road on a via leg

**Files:**
- Modify: `plan.js:105-124` (route helpers), `:864-870` (per-leg route in `render`), `:928-937` (`recompute`), `:1130-1142` (`updateSummary`), `:1029-1031` (road pruning), `:574-606` (`roadOffer`/`roadChipHtml` guard)

**Interfaces:**
- Produces: `legRoute(leg) → {distanceKm, durationMin, state, source, road?} | null` (null while any segment is unknown); `legDrivingMinutes(leg) → number | null`; `requestLiveChain(leg, cb)`.

- [ ] **Step 1: Failing e2e** — in `plan-stops.spec.js`, the "adds a stop" test already asserts `.leg-meta` contains `km` after the stop is picked (catalogue towns are measured from the local route table, so this passes offline once the chain is summed). Add one more case inside the viewport describe:

```js
    test('a leg with a stop drops its road chip and sends no road', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo Airport (CMB)|Galle') + '&roads=no_tolls&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await card.locator('.add-via').click();
      const via = card.locator('.leg-via');
      await via.fill('Hikkaduwa');
      await page.locator('.place-option', { hasText: 'Hikkaduwa' }).first().click();
      await expect(card.locator('.lm-road')).toHaveCount(0);
      await page.locator('#request-btn').click();
      await page.locator('#dates-continue').click();
      await page.waitForURL('**/booking.html?**');
      expect(new URL(page.url()).searchParams.get('roads')).toBeNull();
    });
```

- [ ] **Step 2: Run red** — `cd web-tests && npx playwright test plan-stops`. Expected: "adds a stop" and "road chip" FAIL.

- [ ] **Step 3: Implement** — add after `dayDrivingMinutes`:

```js
// A leg with stops is measured per consecutive pair and summed — or null while ANY pair is still
// unknown, so a partial route is never priced as the whole leg (ops legKm, ops-ui.html:5790).
// A chain never carries a road (ops GC-10), so only a plain leg reads legRouteEstimate's road.
function legRoute(leg){
  const chain=legChain(leg);
  if(chain.length===2) return legRouteEstimate(chain[0],chain[1]);
  let km=0, min=0, state='browse', source='reviewed', durationComplete=true;
  for(let k=0;k<chain.length-1;k++){
    const r=baseRouteEstimate(chain[k],chain[k+1]);
    if(!r || r.distanceKm==null) return null;
    km+=r.distanceKm;
    if(r.durationMin>0) min+=r.durationMin; else durationComplete=false;
    if(r.state==='estimated') state='estimated';
    if(r.source==='google') source='google'; else if(r.source==='estimated' && source!=='google') source='estimated';
  }
  return { distanceKm:km, durationMin:durationComplete?min:null, state, source };
}
function legDrivingMinutes(leg){
  const chain=legChain(leg); let total=0;
  for(let k=0;k<chain.length-1;k++){ const m=dayDrivingMinutes(chain[k],chain[k+1]); if(m==null) return null; total+=m; }
  return total;
}
function requestLiveChain(leg, cb){
  const chain=legChain(leg);
  for(let k=0;k<chain.length-1;k++){
    const r=baseRouteEstimate(chain[k],chain[k+1]);
    if((!r || r.state==='estimated') && chain[k] && chain[k+1]) requestLiveRoute(chain[k],chain[k+1],cb);
  }
}
```

In `render()` per-leg: `const route=!isStay?legRoute(leg):null;` and replace the `requestLiveRoute(leg.from, leg.to, …)` line with `if(!isStay) requestLiveChain(leg, ()=>render());`. In the header, pass `liveRouteKey(leg.from,leg.to)` only for plain legs: `distHtml(route,price,(leg.via||[]).length?null:liveRouteKey(leg.from,leg.to))` and in `distHtml` guard the road chip with `key ? roadChipHtml(key) : ''` (find the `roadChipHtml(key)` call inside `distHtml` and wrap it).

In `recompute()`: `const route=legRoute(state.legs[i]);` and the `distHtml(...)` call with the same key rule.

In `updateSummary()`: `const route=legRoute(l);` and `if(route.state==='estimated')` stays.

In `sameDayDrivingIssue()`: `const minutes=legDrivingMinutes(leg);`.

Road pruning (line ~1029): build `driveKeys` from plain legs only — `state.legs.filter(l=>l.type!=='stay' && !(l.via||[]).length)`, so a leg that gained a stop loses its `roadChoice` entry on the next render (spec §2).

`routeSeqDetailed()` (Task 17) already measures per pair with `legRouteEstimate(chain[k],chain[k+1])`; for a chain the road is never chosen (the key was pruned), so `wireRoad`/`wireChosen` are empty on chain wires.

- [ ] **Step 4: Run green** — `npm run stamp && cd web-tests && npx playwright test plan-stops plan-`. Expected: all `plan-*` specs PASS (existing planner specs included).

- [ ] **Step 5: Commit**

```bash
git add plan.js $(git diff --name-only | grep -E '\.html$')
git commit -m "feat(plan): price a leg with stops on its segment sum; a chain has no road choice"
```

### Task 20: hard stop — same place twice in a row

**Files:**
- Modify: `plan.js` (`render` per-leg, `firstIncompleteLeg`, `updateSummary` gate, `showDatesStep`), `plan.html` style block
- Test: `web-tests/e2e/plan-stops-warnings.spec.js`

**Interfaces:**
- Produces: `legChainDuplicate(leg) → boolean` (consecutive equal, trimmed, case-insensitive via `norm`); `legBlockers() → { i, reason }[]`.

- [ ] **Step 1: Failing e2e** — create `web-tests/e2e/plan-stops-warnings.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];
test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});
const enc = (s) => encodeURIComponent(s);

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile });

    test('same place twice in a row blocks Next with a red note; fixing it clears', async ({ page }) => {
      await page.goto('/plan.html?stops=' + enc('Kandy|Sigiriya / Dambulla|Sigiriya / Dambulla') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card).toHaveClass(/leg-bad/);
      await expect(card.locator('.leg-warn.stop')).toContainText('Same place twice in a row');
      await expect(card.locator('.leg-meta')).toContainText('Fix the route');
      await expect(card.locator('.add-via')).toBeDisabled();
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#route-incomplete-hint')).toContainText('Fix Leg 1 to continue');
      const via = card.locator('.rb-field.via');
      await via.hover();
      await via.locator('.stop-rm').click();
      await expect(card).not.toHaveClass(/leg-bad/);
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
    });

    test('a round trip through a stop is allowed and priced', async ({ page }) => {
      await page.goto('/plan.html?stops=' + enc('Kandy|Sigiriya / Dambulla|Kandy') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      const card = page.locator('#rail .leg-card').first();
      await expect(card.locator('.leg-warn')).toHaveCount(0);
      await expect(card.locator('.leg-meta')).toContainText('km');
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
    });
  });
}
```

- [ ] **Step 2: Run red** — `cd web-tests && npx playwright test plan-stops-warnings`. Expected: FAIL (no `.leg-warn.stop`).

- [ ] **Step 3: CSS** — add to `plan.html` style block after the `.dr-warn b{…}` rule:

```css
  /* per-leg notes under the rail: a hard stop (red) or an ask (amber, see .long-day) */
  .leg-warn{display:flex;flex-direction:column;gap:8px;margin-top:12px;padding:9px 12px;border-radius:12px;font-size:.79rem;line-height:1.4;background:#fff6e8;border:1px solid #f3dca8;color:#7a5512}
  .leg-warn .lw-row{display:flex;gap:.5rem;align-items:flex-start}
  .leg-warn .lw-ic{display:grid;place-items:center;flex:none;margin-top:1px}
  .leg-warn .lw-ic svg{width:16px;height:16px;color:#c98a1a}
  .leg-warn b{color:var(--ink)}
  .leg-warn.stop{background:#fdecea;border-color:#f3b6ad;color:#8a2217}
  .leg-warn.stop .lw-ic svg{color:var(--tomato)}
  .leg-warn.stop b{color:#8a2217}
```

- [ ] **Step 4: Implement** in `plan.js`. Helpers near `firstIncompleteLeg`:

```js
// Consecutive repeats only (ops legChainDuplicate; engine validateRide): Kandy → Pinnawala →
// Kandy is a round trip and fine; Kandy → Kandy, or a stop equal to the drop-off, is an error.
function legChainDuplicate(leg){
  if(leg.type==='stay') return false;
  const c=legChain(leg).map(norm);
  for(let k=0;k<c.length-1;k++) if(c[k] && c[k+1] && c[k]===c[k+1]) return true;
  return false;
}
// Everything that blocks "Next" on the route step, by leg, first problem first.
function legBlockers(){
  const out=[]; let n=0;
  state.legs.forEach((l,i)=>{ if(l.type!=='stay') n++; if(legChainDuplicate(l)) out.push({ i, legNo:n, reason:'duplicate' }); });
  return out;
}
```

Extend `firstIncompleteLeg()` so blank stops count: in the transfer branch add `|| (l.via||[]).some(v=>!(v||'').trim())`.

In `render()` per transfer: compute `const dup=legChainDuplicate(leg);` before building the card; add `leg-bad` to the card class when `dup`; in the header use `dup ? '<span class="lm-hint">Fix the route to see distance &amp; price</span>' : distHtml(...)`; set `disabled` on `.add-via` when `dup || via.length>=4`; and append under the route block:

```js
        ${dup?`<div class="leg-warn stop" role="alert"><div class="lw-row"><span class="lw-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg></span><span><b>Same place twice in a row.</b> ${escAttr(dupPairText(leg))} — remove one, or change it.</span></div></div>`:''}
```

with `function dupPairText(leg){ const c=legChain(leg), n=c.map(norm); for(let k=0;k<c.length-1;k++) if(n[k]&&n[k]===n[k+1]){ const names=['The pick-up','A stop on the way','The drop-off']; const who=(x)=>x===0?names[0]:(x===c.length-1?names[2]:names[1]); return `${who(k)} and ${who(k+1).toLowerCase()} are both ${c[k]}`; } return ''; }`.

In `updateSummary()` the gate: 

```js
  const blockers=legBlockers();
  const incompleteLeg = firstIncompleteLeg()>=0;
  const blocked = incompleteLeg || blockers.length>0 || pendingAsks().length>0;
  const reqBtn=document.getElementById('request-btn');
  if(reqBtn){ reqBtn.classList.toggle('cta-disabled', blocked); reqBtn.setAttribute('aria-disabled', blocked?'true':'false'); }
  const reqHint=document.getElementById('route-incomplete-hint');
  if(reqHint){
    reqHint.hidden=!blocked;
    const t=reqHint.lastChild; // the text node after the svg
    if(blockers.length) t.textContent=` Fix Leg ${blockers[0].legNo} to continue`;
    else if(pendingAsks().length) t.textContent=` Answer the note on Leg ${pendingAsks()[0].legNo} to continue`;
    else t.textContent=' Add a pick-up and drop-off to every leg to continue.';
  }
```

`pendingAsks()` arrives in Task 21; until then define it as `function pendingAsks(){ return []; }` so this compiles.

In `showDatesStep()` after the `bad>=0` check: `const b=legBlockers(); if(b.length){ flagIncompleteLeg(b[0].i); return; }`.

- [ ] **Step 5: Run green** — `npm run stamp && cd web-tests && npx playwright test plan-stops-warnings plan-stops`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plan.html plan.js web-tests/e2e/plan-stops-warnings.spec.js $(git diff --name-only | grep -E '\.html$')
git commit -m "feat(plan): block Next on a same-place-twice-in-a-row leg"
```

### Task 21: the long-day ask — split or keep

**Files:**
- Modify: `plan.js` (`render` per-leg, `pendingAsks`, `updateSummary`, `showDatesStep`), `plan.html` style block
- Test: `web-tests/e2e/plan-stops-warnings.spec.js`

**Interfaces:**
- Produces: `LONG_DAY_MIN = 360`; `legLongDay(leg) → { minutes, splitAt: number } | null`; `pendingAsks() → { i, legNo }[]`; buttons `.dw-split`, `.dw-keep`.

- [ ] **Step 1: Failing e2e** — append inside the viewport describe in `plan-stops-warnings.spec.js`:

```js
    test('a ≥ 6 h leg asks; Keep enables Next and reaches booking as ack; Split makes two legs', async ({ page }) => {
      // CMB → Ella → Arugam Bay is well over 6 h on the modelled km/42 clock.
      const go = () => page.goto('/plan.html?stops=' + enc('Colombo Airport (CMB)|Ella|Arugam Bay') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      await go();
      const card = page.locator('#rail .leg-card').first();
      const ask = card.locator('.leg-warn.long-day');
      await expect(ask).toContainText('Long day on the road');
      await expect(ask.locator('.dw-split')).toContainText('end this leg at Ella');
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#route-incomplete-hint')).toContainText('Answer the note on Leg 1');
      await ask.locator('.dw-keep').click();
      await expect(card.locator('.leg-warn')).toHaveCount(0);
      await expect(page.locator('#request-btn')).toHaveAttribute('aria-disabled', 'false');
      await page.locator('#request-btn').click();
      await page.locator('#dates-continue').click();
      await page.waitForURL('**/booking.html?**');
      expect(new URL(page.url()).searchParams.get('ack')).toBe('0');

      await go();
      await page.locator('.leg-warn.long-day .dw-split').click();
      await expect(page.locator('#rail .leg-card')).toHaveCount(2);
      await expect(page.locator('#rail .leg-card').nth(0).locator('.leg-to')).toHaveValue('Ella');
      await expect(page.locator('#rail .leg-card').nth(1).locator('.leg-from')).toHaveValue('Ella');
      await expect(page.locator('#rail .leg-card').nth(1).locator('.leg-to')).toHaveValue('Arugam Bay');
      await expect(page.locator('#rail .leg-via')).toHaveCount(0);
    });

    test('editing a kept leg asks again', async ({ page }) => {
      await page.goto('/plan.html?stops=' + enc('Colombo Airport (CMB)|Ella|Arugam Bay') + '&nights=0,0,0&through=0&ack=0&pax=2&vehicle=car');
      await expect(page.locator('.leg-warn.long-day')).toHaveCount(0);
      const via = page.locator('#rail .leg-via');
      await via.fill('Kandy');
      await page.locator('.place-option', { hasText: 'Kandy' }).first().click();
      await expect(page.locator('.leg-warn.long-day')).toHaveCount(1);
    });
```

- [ ] **Step 2: Run red** — `cd web-tests && npx playwright test plan-stops-warnings -g "6 h|kept leg"`. Expected: FAIL.

- [ ] **Step 3: CSS** — add after the `.leg-warn.stop b` rule:

```css
  .leg-warn.long-day .lw-actions{display:flex;gap:8px;flex-wrap:wrap;padding-left:24px}
  .dw-btn{font-family:inherit;font-size:.78rem;font-weight:700;padding:.42rem .8rem;border-radius:999px;cursor:pointer;border:1.5px solid #e6b980;background:var(--white);color:#8a4f07;min-height:34px}
  .dw-btn.dw-split{background:#8a4f07;border-color:#8a4f07;color:#fff}
  .dw-btn:hover{filter:brightness(.97)}
  .dw-btn:focus-visible{outline:2px solid var(--btn-accent,#24758A);outline-offset:2px}
  @media(max-width:420px){.leg-warn.long-day .lw-actions{padding-left:0}.dw-btn{flex:1 1 100%}}
```

- [ ] **Step 4: Implement** in `plan.js`. Helpers (replace the Task 20 stub):

```js
const LONG_DAY_MIN = 360; // ops "Long drive warning": legDriveHours(leg) >= 6 (ops-ui.html:10793)
// A leg that would be a long day on the road. splitAt is the chain index of the stop that leaves
// the two halves closest to equal time — the place "Split it" turns into this leg's drop-off.
function legLongDay(leg){
  if(leg.type==='stay' || leg.ack==='long_day') return null;
  const minutes=legDrivingMinutes(leg);
  if(minutes==null || minutes<LONG_DAY_MIN) return null;
  const chain=legChain(leg); let splitAt=null;
  if(chain.length>2){
    let best=Infinity, acc=0;
    for(let k=0;k<chain.length-2;k++){ acc+=dayDrivingMinutes(chain[k],chain[k+1])||0; const d=Math.abs(acc-(minutes-acc)); if(d<best){ best=d; splitAt=k+1; } }
  }
  return { minutes, splitAt };
}
function pendingAsks(){
  const out=[]; let n=0;
  state.legs.forEach((l,i)=>{ if(l.type!=='stay'){ n++; if(legLongDay(l)) out.push({ i, legNo:n }); } });
  return out;
}
```

In `render()` per transfer, after the hard-stop note (only when not `dup`):

```js
    const ask = !dup ? legLongDay(leg) : null;
    const askHtml = ask ? (()=>{
      const chain=legChain(leg), hrs=Math.round(ask.minutes/60);
      const at = ask.splitAt!=null ? chain[ask.splitAt] : null;
      return `<div class="leg-warn long-day" role="status"><div class="lw-row"><span class="lw-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg></span><span><b>Long day on the road.</b> ${escAttr(chain.join(' → '))} is about ${hrs} hours of driving${chain.length>2?', before any time at the stops':''}.${at?` Most travellers split this with a night in ${escAttr(at)}.`:''}</span></div><div class="lw-actions">${at?`<button type="button" class="dw-btn dw-split" data-k="${ask.splitAt}">Split it — end this leg at ${escAttr(at)}</button>`:''}<button type="button" class="dw-btn dw-keep">Keep it as one day</button></div></div>`;
    })() : '';
```

Append `${askHtml}` to the card after the hard-stop note. Wiring, in the `if(!isStay)` block:

```js
      const keep=wrap.querySelector('.dw-keep');
      if(keep) keep.addEventListener('click',()=>{ markRouteCustomized(); state.legs[i].ack='long_day'; render(); });
      const split=wrap.querySelector('.dw-split');
      if(split) split.addEventListener('click',()=>{
        markRouteCustomized();
        const c=legChain(state.legs[i]), k=+split.dataset.k;
        const first=c.slice(0,k+1), second=c.slice(k);
        state.legs[i]={ ...state.legs[i], from:first[0], to:first[first.length-1], via:first.slice(1,-1), ack:null };
        state.legs.splice(i+1,0,{ type:'transfer', from:second[0], to:second[second.length-1], via:second.slice(1,-1), date:null, nights:1, ack:null });
        render();
      });
```

Every path that edits a leg's chain already sets `ack=null` (Task 18's `setChain`, the via `change` handler, add-via). Also clear it in the `fromI`/`toI` `change` handlers: add `state.legs[i].ack=null;` to each.

`showDatesStep()`: after the blockers check add `const asks=pendingAsks(); if(asks.length){ flagIncompleteLeg(asks[0].i); return; }`.

- [ ] **Step 5: Run green** — `npm run stamp && cd web-tests && npx playwright test plan-stops-warnings plan-stops`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plan.html plan.js web-tests/e2e/plan-stops-warnings.spec.js $(git diff --name-only | grep -E '\.html$')
git commit -m "feat(plan): ask before a 6 h+ day — split the leg at a stop, or keep it and tell ops"
```

### Task 22: map and summary through the stops

**Files:**
- Modify: `plan.js:1226-1300` (`renderMap`)
- Test: `web-tests/e2e/plan-stops.spec.js`

- [ ] **Step 1: Failing e2e** — append inside the viewport describe:

```js
    test('the map draws one line through the stop and one pin per distinct place', async ({ page }) => {
      await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Kandy') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
      await expect(page.locator('#trip-map .tm-route')).toHaveCount(2);
      await expect(page.locator('#trip-map .tm-pin-label')).toHaveCount(2);
    });
```

(Google is aborted in `beforeEach`, so the SVG fallback renders; `.tm-route` is one path per wire.)

- [ ] **Step 2: Run red** — Expected: FAIL (3 pin labels: Kandy twice).

- [ ] **Step 3: Implement** — `points()` already flattens through `routeSeq()`, which now includes via places, so the line is right. For pins, dedup by `norm(name)` in the SVG path: build `pts` as today, then

```js
  const seen=new Map(); const pinPts=[];
  pts.forEach(p=>{ const k=norm(p.name); if(seen.has(k)) return; seen.set(k,true); pinPts.push(p); });
```

and render `pins` from `pinPts` (first/last colours come from `idx===0` / `idx===pinPts.length-1`). Keep the route `line` loop on `pts`.

- [ ] **Step 4: Run green** — `npm run stamp && cd web-tests && npx playwright test plan-stops plan-gapped-route-map`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plan.js $(git diff --name-only | grep -E '\.html$')
git commit -m "feat(plan): route map draws through stops; one pin per place"
```

### Task 23: full gate, visual verification at every width, PR

- [ ] `cd api && npm run check` (untouched, but the repo gate) and `cd web-tests && npm run test:all`. Expected: both green with their own summary lines, exit 0. Paste both.
- [ ] Browser pane: `preview_start` `ceylon-hop-booking` (static server on 4173), open `plan.html?stops=Kandy|Sigiriya / Dambulla|Ella&nights=0,0,0&through=0&pax=2&vehicle=car`. For each of **375 × 812**, **390 × 844**, **768 × 1024**, **1024 × 768**, **1280 × 800**, **1536 × 864**: screenshot the card at rest, hovered (desktop), with the hard stop (`…|Sigiriya / Dambulla|Sigiriya / Dambulla`), and with the long-day ask (`Colombo Airport (CMB)|Ella|Arugam Bay`). Check: no horizontal scroll (`document.documentElement.scrollWidth <= clientWidth`), controls reachable by Tab, `×`/`⇅` hit area ≥ 24 px, the ask's buttons wrap on 375 without clipping, `prefers-reduced-motion` shows controls without transition. Fix anything found as its own commit, re-run the gate.
- [ ] Run the existing planner suite twice more to catch flakes: `cd web-tests && npx playwright test plan- --repeat-each 2`. Expected: 0 failures.
- [ ] Open PR `feat/planner-stops → main` "feat(plan): stops on the way inside a leg (PR 4/4)". Body: spec + prototype links, red→green per task, the viewport screenshots, the kill-switch line, and the one-line **ch-map round-trip pin** proposal for the owner.

---

## Rollout

1. Merge PR 1, then PR 2 (owner OK — migration 0078 applies to staging on merge). PR 3, then PR 4.
2. After PR 4 is on staging: run the three planner flows above against `ops.staging`/staging site by hand at phone and desktop width; book one test trip with a stop and confirm in the ops drawer that the booking shows one leg with the stop (viaStops) and the "Planner: kept a … day" note when applicable.
3. Promote `main → production` per the usual flow. Prod migration gate is the owner's.
4. If anything misbehaves on the live planner: flip `PLANNER_STOPS` to `false` (one-line PR, Pages deploys from `production`), which hides the feature without touching the API.

## Self-review

- Spec §2 definitions → Tasks 2, 9, 10, 19, 20 (one ride, segment sum, consecutive-only duplicates, road cleared, stays excluded, caps in Tasks 1/7/18).
- Spec §3.1–3.2 UX → Task 18. §3.3 header/summary/map → Tasks 19, 22 (ch-map pin merge deferred, stated). §3.4 hard stop → Task 20. §3.5 long-day ask → Task 21; "applies to two-place legs too" holds because `legLongDay` reads any transfer.
- Spec §4.1 → Tasks 1–4. §4.2 → Tasks 6–12. §4.3 → Tasks 14–15, 17. §4.4 → Task 15 (notes line) + Task 17 (`ack` param).
- Spec §6 tests → each task carries its own; viewports in Tasks 17–21; migration test Task 6; DB round trip Task 11; goldens Tasks 2, 4, 12.
- Names used across tasks: `legChain`, `legRoute`, `legDrivingMinutes`, `legChainDuplicate`, `legBlockers`, `pendingAsks`, `legLongDay`, `tripRunOf`, `tripIsCont`, `tripThrough`, `tripAcks`, `viaWithRoad`, `intentSegments`, `tripRides`, `tripThroughProblem` — each defined before first use in task order.
