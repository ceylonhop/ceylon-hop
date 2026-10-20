# Customer Route Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer pick a cheaper toll-free "local road" instead of the expressway, on
`search.html` for a single transfer and on `plan.html` per drive, and have that choice priced by
the server, stored on the booking, and shown to ops and in emails.

**Architecture:** The server stays the only thing that measures a road. A new optional leg field
`routeVariant` makes the estimate and booking price a leg at the toll-free km from the existing
`MapsAdapter.distanceVariants()`. A lifted request flag `compareRoutes` returns both prices so the
pages can offer the choice. One nullable column per request table stores it. A shared browser
component (`route-choice.js`) draws the popup on both pages.

**Tech stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres (API in
`api/`). Classic browser scripts at the repo root (no bundler) · Playwright + Vitest/jsdom in
`web-tests/`.

**Spec:** `docs/superpowers/specs/2026-09-26-customer-route-choice-design.md` (owner-approved
2026-09-27). Read it before any task.

**Spike result (step 0, run 2026-09-27 against the real Google key, 20 pairs):** 3 pairs are real,
cheaper forks. Colombo Airport → Ella is 335 km / 299 min against 213 km / 374 min, about $49 on a
car. Colombo City → Ella is 309 / 301 against 196 / 350, about $45. Colombo Airport → Yala is
317 / 308 against 269 / 448, about $19. The other 17 pairs are not material. Verdict: build.

## Global Constraints

- **Branching.** One task = one branch = one PR, each in its own git worktree, never in the shared
  checkout at `/Users/roshenw/claude_code/ceylon-hop`. The tasks depend on each other, so the
  branches are **stacked**:
  - `rc/1-api` off `origin/main`.
  - `rc/2-booking-api` off `rc/1-api`.
  - `rc/3-booking-page` off `rc/2-booking-api`.
  - `rc/4-search` off `rc/3-booking-page`.
  - `rc/5-plan` off `rc/4-search`.
- **PRs.** Each PR's base is its parent branch. Its description starts with
  "Stacked on #N — retarget to `main` after #N merges; merge bottom-up". Nothing is merged by the
  build. Migration `0059` releases to staging on merge, so it needs the owner's explicit OK.
- **Git binary.** `/usr/bin/git` is blocked by the Xcode licence prompt. Use
  `/Library/Developer/CommandLineTools/usr/bin/git`. Start every shell chain with
  `cd <abs worktree> || exit 1`. Assert the branch before committing. Stage by path, never
  `git add -A`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end
  with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Money** is integer minor units. Prices come from the engine (`quote()`) or, on the plan page
  only, from the page's own `legPrice()`. Never add a client-sent distance to any API.
- **Interfaces.** Nothing may change the rate card (`api/src/quote/rateCard.ts`), `config.ts`,
  `@generated:` blocks, or generated pages. The only new interfaces are listed per task.
- **API gate.** `cd api && npm run check` with `DATABASE_URL_TEST` set to a **throwaway** local
  database, never `api/.env`'s `DATABASE_URL`, which is PROD:

  ```bash
  createdb -h localhost -U postgres ceylonhop_test_rc 2>/dev/null || true
  export DATABASE_URL_TEST='postgresql://postgres:postgres@localhost:5432/ceylonhop_test_rc'
  cd api && npm run migrate:test && npm run check
  ```

  If Postgres isn't running locally, say so in the PR and rely on CI for the DB suites.
- **Web gate.** Run `npm --prefix <abs worktree>/web-tests run test:all` in the FOREGROUND with a
  Bash `timeout: 600000`. It runs Vitest plus Playwright. Check that the log holds both summaries.
  In a fresh worktree run `npm --prefix <abs>/web-tests ci` and `npm --prefix <abs>/api ci` once
  first.
- **Asset stamps.** After editing any root asset (`*.js`, `*.css`), run `npm run stamp` from the
  worktree root and commit the restamped HTML with the change. Never edit `site.css`. The new
  component injects its own styles.
- **Test dates** come from `api/src/testSupport/dates.ts` (API) or `web-tests/dates.js` (web).
  Never hard-code a future date.
- **Red → green.** Every task writes its failing tests first, runs them to see them fail, then
  implements. Paste the red and green summary lines into the PR body.
- **Copy** is taken verbatim from this plan. The owner signs it off at review.
- **No new dependencies**, services or config.

---

### Task 1: API — price the local road, and compare the two roads

**Branch:** `rc/1-api` off `origin/main`.

**Files:**
- Create: `api/src/quote/routeChoice.ts`
- Create: `api/src/quote/routeChoice.test.ts`
- Modify: `api/src/quote/webQuoteV2.ts:24-31` (private leg schema)
- Modify: `api/src/routes/quote.ts:65-129` (`ResolvedLeg`, `engineRequestFor`), `:254-307`
  (`/v2/estimate`), `:309-345` (`/v2/estimate-batch`)
- Modify: `api/src/routes/bookings.ts:79-95` (`memoizeDistance` also memoizes
  `distanceVariants`)
- Test: `api/src/routes/quote.test.ts` (new `describe('route choice (v2)')` block at the end)

**Interfaces produced (later tasks rely on these exact names):**

```ts
// api/src/quote/routeChoice.ts
export const ROUTE_VARIANTS = ['fastest', 'no_tolls'] as const;
export type RouteVariant = (typeof ROUTE_VARIANTS)[number];
export interface MeasuredLeg { km: number; durationMin: number; estimated?: boolean; variant: RouteVariant }
export async function measureLeg(maps: MapsAdapter, from: string, to: string, want?: RouteVariant): Promise<MeasuredLeg | null>;
export interface RouteChoiceSide { distanceKm: number; durationMin: number; totalCents: number }
export interface RouteChoice { fastest: RouteChoiceSide; noTolls: RouteChoiceSide }
// `fastest` is the distance the main price was ALREADY measured with (resolved.legs[0]) —
// passed in so the comparison bills no second distance lookup and can never disagree with it.
export async function cheaperRouteChoice(
  maps: MapsAdapter, from: string, to: string,
  fastest: DistanceResult,
  priceAtKm: (km: number) => number,
): Promise<RouteChoice | null>;
export const MAX_COMPARE_PER_BATCH = 12;
```

- HTTP: a private leg in `POST /quote/v2/estimate` and in `/v2/estimate-batch` intents accepts
  `routeVariant?: 'fastest' | 'no_tolls'`.
- **`/v2/lock` and `PUT /v2/:id` refuse it** with 400 `route_choice_not_supported`. They share
  `WebQuoteIntentSchema`, and a locked quote converts to a booking through `quoteToBooking`, which
  would drop the road. The result would be a local-road price with no road for ops.
- The response `legs[i]` carries `routeVariant` **only when that leg asked for one**, with the
  road actually priced.
- A lifted body flag `compareRoutes: true`, allowed only on a one-leg private intent in
  `/v2/estimate` and in each batch intent, adds `routeChoice: RouteChoice` when the local road is
  cheaper.

- [ ] **Step 1: Write the failing unit tests** — `api/src/quote/routeChoice.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { DistanceResult, MapsAdapter, RouteVariants } from '../adapters/maps';
import { cheaperRouteChoice, measureLeg } from './routeChoice';

const FAST: DistanceResult = { km: 335, durationMin: 299 };
const SLOW: DistanceResult = { km: 213, durationMin: 374 };
const FORK: RouteVariants = { fastest: FAST, noTolls: SLOW, hasChoice: true };
const NO_FORK: RouteVariants = { fastest: FAST, noTolls: null, hasChoice: false };

function stub(opts: { fast?: DistanceResult | null; variants?: RouteVariants | null; variantsThrow?: boolean } = {}) {
  const calls = { distance: 0, variants: 0 };
  const maps: MapsAdapter = {
    provider: 'stub',
    async distance() { calls.distance++; return opts.fast === undefined ? FAST : opts.fast; },
    async distanceVariants() {
      calls.variants++;
      if (opts.variantsThrow) throw new Error('google down');
      return opts.variants === undefined ? FORK : opts.variants;
    },
    async places() { return []; },
  };
  return { maps, calls };
}

describe('measureLeg', () => {
  it('measures the fastest road and never asks for variants when no road is requested', async () => {
    const { maps, calls } = stub();
    expect(await measureLeg(maps, 'A', 'B')).toEqual({ km: 335, durationMin: 299, variant: 'fastest' });
    expect(await measureLeg(maps, 'A', 'B', 'fastest')).toEqual({ km: 335, durationMin: 299, variant: 'fastest' });
    expect(calls.variants).toBe(0);
  });

  it('measures the toll-free road when a material fork exists', async () => {
    const { maps } = stub();
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toEqual({ km: 213, durationMin: 374, variant: 'no_tolls' });
  });

  it('falls back to the fastest road when there is no fork', async () => {
    const { maps } = stub({ variants: NO_FORK });
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toEqual({ km: 335, durationMin: 299, variant: 'fastest' });
  });

  it('falls back to the fastest road when the comparison throws', async () => {
    const { maps } = stub({ variantsThrow: true });
    expect((await measureLeg(maps, 'A', 'B', 'no_tolls'))?.variant).toBe('fastest');
  });

  it('never trades an estimated (offline) distance for a variant', async () => {
    const { maps, calls } = stub({ fast: { km: 300, durationMin: 400, estimated: true } });
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toEqual({ km: 300, durationMin: 400, estimated: true, variant: 'fastest' });
    expect(calls.variants).toBe(0);
  });

  it('returns null when the pair does not resolve', async () => {
    const { maps } = stub({ fast: null });
    expect(await measureLeg(maps, 'A', 'B', 'no_tolls')).toBeNull();
  });
});

describe('cheaperRouteChoice', () => {
  const perKm = (km: number) => km * 40; // any monotonic price is enough here

  it('returns both roads with their prices when the local road is cheaper, without re-measuring', async () => {
    const { maps, calls } = stub();
    expect(await cheaperRouteChoice(maps, 'A', 'B', FAST, perKm)).toEqual({
      fastest: { distanceKm: 335, durationMin: 299, totalCents: 13400 },
      noTolls: { distanceKm: 213, durationMin: 374, totalCents: 8520 },
    });
    expect(calls.distance).toBe(0); // the caller's measured distance is reused, never re-billed
  });

  it('returns null without a fork, on an estimated distance, or when the comparison throws', async () => {
    expect(await cheaperRouteChoice(stub({ variants: NO_FORK }).maps, 'A', 'B', FAST, perKm)).toBeNull();
    const est = stub();
    expect(await cheaperRouteChoice(est.maps, 'A', 'B', { km: 300, durationMin: 1, estimated: true }, perKm)).toBeNull();
    expect(est.calls.variants).toBe(0);
    expect(await cheaperRouteChoice(stub({ variantsThrow: true }).maps, 'A', 'B', FAST, perKm)).toBeNull();
  });

  it('returns null when the toll-free road is not cheaper (floor fare, or longer road)', async () => {
    expect(await cheaperRouteChoice(stub().maps, 'A', 'B', FAST, () => 2900)).toBeNull();
    const longer: RouteVariants = { fastest: FAST, noTolls: { km: 360, durationMin: 420 }, hasChoice: true };
    expect(await cheaperRouteChoice(stub({ variants: longer }).maps, 'A', 'B', FAST, perKm)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd api && npx vitest run src/quote/routeChoice.test.ts`
Expected: FAIL — `Failed to resolve import "./routeChoice"`.

- [ ] **Step 3: Implement `api/src/quote/routeChoice.ts`**

```ts
// Customer route choice (spec 2026-09-26-customer-route-choice-design.md §4.1).
//
// The server is the only thing that ever measures a road: a customer page may ASK for the
// toll-free road, but its km always comes from distanceVariants() here, never from the client.
// The main distance keeps coming from maps.distance() — the call that flags an offline
// (crow-flies) estimate — because distanceVariants().fastest silently falls back to that same
// estimate without the flag (maps.ts offlineEstimate). Only `noTolls` is taken from the
// comparison, and it only exists when BOTH Google answers succeeded with a material gap.
import type { DistanceResult, MapsAdapter } from '../adapters/maps';

export const ROUTE_VARIANTS = ['fastest', 'no_tolls'] as const;
export type RouteVariant = (typeof ROUTE_VARIANTS)[number];

export interface MeasuredLeg {
  km: number;
  durationMin: number;
  estimated?: boolean;
  /** The road actually measured — 'fastest' whenever a requested local road couldn't be confirmed. */
  variant: RouteVariant;
}

export async function measureLeg(
  maps: MapsAdapter,
  from: string,
  to: string,
  want?: RouteVariant,
): Promise<MeasuredLeg | null> {
  const fastest = await maps.distance(from, to);
  if (!fastest) return null;
  const onFastest: MeasuredLeg = { ...fastest, variant: 'fastest' };
  if (want !== 'no_tolls' || fastest.estimated) return onFastest;
  const v = await maps.distanceVariants(from, to).catch(() => null);
  if (!v || !v.hasChoice || !v.noTolls) return onFastest;
  return { km: v.noTolls.km, durationMin: v.noTolls.durationMin, variant: 'no_tolls' };
}

export interface RouteChoiceSide {
  distanceKm: number;
  durationMin: number;
  totalCents: number;
}
export interface RouteChoice {
  fastest: RouteChoiceSide;
  noTolls: RouteChoiceSide;
}

// Both roads, priced, ONLY when the toll-free one is genuinely cheaper. The ops fork test
// (isMaterialRouteChoice) takes an absolute km gap, so it also flags a toll-free road that is
// longer AND slower; a customer is only ever offered a saving (spec §4.1 "Cheaper, not just
// different"). A pair on the vehicle floor fare prices the same both ways and is never offered.
// Server-side cap on compared intents per estimate-batch: each comparison is two Google elements,
// and a plan holds at most 10 drives (spec §7). Intents past the cap are priced but not compared.
export const MAX_COMPARE_PER_BATCH = 12;

export async function cheaperRouteChoice(
  maps: MapsAdapter,
  from: string,
  to: string,
  fastest: DistanceResult,
  priceAtKm: (km: number) => number,
): Promise<RouteChoice | null> {
  if (fastest.estimated) return null;
  const v = await maps.distanceVariants(from, to).catch(() => null);
  if (!v || !v.hasChoice || !v.noTolls) return null;
  const fastCents = priceAtKm(fastest.km);
  const slowCents = priceAtKm(v.noTolls.km);
  if (!(slowCents < fastCents)) return null;
  return {
    fastest: { distanceKm: fastest.km, durationMin: fastest.durationMin, totalCents: fastCents },
    noTolls: { distanceKm: v.noTolls.km, durationMin: v.noTolls.durationMin, totalCents: slowCents },
  };
}
```

- [ ] **Step 4: Run the unit tests green**

Run: `cd api && npx vitest run src/quote/routeChoice.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing route tests.** Append the `describe` block to
  `api/src/routes/quote.test.ts`, and move its three `import` lines to the top of the file with
  the others.

```ts
import type { DistanceResult, RouteVariants } from '../adapters/maps';
import { RATE_CARD } from '../quote/rateCard';
import { quote as priceQuote } from '../quote/engine';

describe('route choice (v2)', () => {
  const FAST: DistanceResult = { km: 335, durationMin: 299 };
  const SLOW: DistanceResult = { km: 213, durationMin: 374 };
  const FORK: RouteVariants = { fastest: FAST, noTolls: SLOW, hasChoice: true };

  function forkMaps(variants: RouteVariants | null = FORK, fast: DistanceResult = FAST): MapsAdapter & { variantCalls: number } {
    const m = {
      provider: 'stub',
      variantCalls: 0,
      async distance() { return fast; },
      async distanceVariants() { m.variantCalls++; return variants; },
      async places() { return []; },
    };
    return m;
  }
  function appWith(maps: MapsAdapter) {
    const app = new Hono();
    app.route('/quote', quoteRoutes({ quotes: new InMemoryQuoteRepo(), maps, v2Enabled: true }));
    return app;
  }
  const send = (app: Hono, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ONE = (leg: Record<string, unknown> = {}) => ({
    product: 'private', vehicle: 'car', pax: 1, bags: 0, extras: [],
    legs: [{ from: 'Colombo Airport (CMB)', to: 'Ella', ...leg }],
  });
  // The engine's own price for a car at `km`, on the same card the route uses (no zones seeded).
  const carAt = (km: number) => priceQuote(
    { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ from: 'Colombo Airport (CMB)', to: 'Ella', distanceKm: km }], extras: [] },
    RATE_CARD,
  ).totalCents;

  it('prices a requested local road at the toll-free km and echoes the road priced', async () => {
    const res = await send(appWith(forkMaps()), '/quote/v2/estimate', ONE({ routeVariant: 'no_tolls' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCents).toBe(carAt(213));
    expect(body.legs[0]).toMatchObject({ distanceKm: 213, durationMin: 374, routeVariant: 'no_tolls' });
  });

  it('prices the expressway and echoes fastest when there is no fork', async () => {
    const noFork: RouteVariants = { fastest: FAST, noTolls: null, hasChoice: false };
    const body = await (await send(appWith(forkMaps(noFork)), '/quote/v2/estimate', ONE({ routeVariant: 'no_tolls' }))).json();
    expect(body.totalCents).toBe(carAt(335));
    expect(body.legs[0].routeVariant).toBe('fastest');
  });

  it('leaves legs without a routeVariant key when none was asked for', async () => {
    const body = await (await send(appWith(forkMaps()), '/quote/v2/estimate', ONE())).json();
    expect(body.legs[0]).toEqual({ from: 'Colombo Airport (CMB)', to: 'Ella', distanceKm: 335, durationMin: 299 });
    expect(body.routeChoice).toBeUndefined();
  });

  it('prices each leg of a multi-leg intent on its own road', async () => {
    const body = await (await send(appWith(forkMaps()), '/quote/v2/estimate', {
      ...ONE(), legs: [{ from: 'Kandy', to: 'Ella' }, { from: 'Ella', to: 'Yala', routeVariant: 'no_tolls' }],
    })).json();
    expect(body.legs.map((l: { distanceKm: number }) => l.distanceKm)).toEqual([335, 213]);
    expect(body.legs[0].routeVariant).toBeUndefined();
    expect(body.legs[1].routeVariant).toBe('no_tolls');
  });

  it('compareRoutes returns both roads priced when the local road is cheaper', async () => {
    const maps = forkMaps();
    const body = await (await send(appWith(maps), '/quote/v2/estimate', { ...ONE(), compareRoutes: true })).json();
    expect(body.totalCents).toBe(carAt(335));
    expect(body.routeChoice).toEqual({
      fastest: { distanceKm: 335, durationMin: 299, totalCents: carAt(335) },
      noTolls: { distanceKm: 213, durationMin: 374, totalCents: carAt(213) },
    });
    expect(maps.variantCalls).toBe(1);
  });

  it('compareRoutes adds nothing without a fork or when the local road is not cheaper', async () => {
    const noFork: RouteVariants = { fastest: FAST, noTolls: null, hasChoice: false };
    expect((await (await send(appWith(forkMaps(noFork)), '/quote/v2/estimate', { ...ONE(), compareRoutes: true })).json()).routeChoice).toBeUndefined();
    const longer: RouteVariants = { fastest: FAST, noTolls: { km: 360, durationMin: 420 }, hasChoice: true };
    expect((await (await send(appWith(forkMaps(longer)), '/quote/v2/estimate', { ...ONE(), compareRoutes: true })).json()).routeChoice).toBeUndefined();
  });

  it('refuses compareRoutes on two legs, a non-true value, or a chauffeur intent; refuses routeVariant on a chauffeur day', async () => {
    const app = appWith(forkMaps());
    expect((await send(app, '/quote/v2/estimate', { ...ONE(), legs: [{ from: 'Kandy', to: 'Ella' }, { from: 'Ella', to: 'Yala' }], compareRoutes: true })).status).toBe(400);
    expect((await send(app, '/quote/v2/estimate', { ...ONE(), compareRoutes: 'yes' })).status).toBe(400);
    const chauffeur = {
      product: 'chauffeur', vehicle: 'car', pax: 1, bags: 0, extras: [], firstDate: '2030-01-01', lastDate: '2030-01-02',
      travelDays: [{ date: '2030-01-01', from: 'Kandy', to: 'Ella' }],
    };
    expect((await send(app, '/quote/v2/estimate', { ...chauffeur, compareRoutes: true })).status).toBe(400);
    expect((await send(app, '/quote/v2/estimate', { ...chauffeur, travelDays: [{ date: '2030-01-01', from: 'Kandy', to: 'Ella', routeVariant: 'no_tolls' }] })).status).toBe(400);
  });

  it('refuses a road on /v2/lock and on PUT /v2/:id — a locked quote cannot carry it to a booking', async () => {
    const app = appWith(forkMaps());
    const lock = await send(app, '/quote/v2/lock', ONE({ routeVariant: 'no_tolls' }));
    expect(lock.status).toBe(400);
    expect((await lock.json()).error).toBe('route_choice_not_supported');
    // PUT: lock a plain intent first, then try to update it with a road. Use the same
    // id/accessToken/revision headers the existing 'public quote v2 lock' PUT tests use.
    const created = await (await send(app, '/quote/v2/lock', ONE())).json();
    const put = await app.request(`/quote/v2/${created.quoteId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.accessToken}` },
      body: JSON.stringify({ revision: created.revision, intent: ONE({ routeVariant: 'no_tolls' }) }),
    });
    expect(put.status).toBe(400);
    expect((await put.json()).error).toBe('route_choice_not_supported');
  });

  it('still refuses a client-sent distance on a leg', async () => {
    expect((await send(appWith(forkMaps()), '/quote/v2/estimate', ONE({ distanceKm: 1 }))).status).toBe(400);
  });

  it('estimate-batch returns routeChoice per catalogue intent and still skips non-catalogue legs', async () => {
    const body = await (await send(appWith(forkMaps()), '/quote/v2/estimate-batch', {
      intents: [
        { ...ONE(), compareRoutes: true },
        ONE(),
        { ...ONE(), legs: [{ from: '12 Temple Rd, Ella', to: 'Kandy' }], compareRoutes: true },
      ],
    })).json();
    expect(body.results[0]).toMatchObject({ totalCents: carAt(335), routeChoice: { noTolls: { distanceKm: 213 } } });
    expect(body.results[1].routeChoice).toBeUndefined();
    expect(body.results[2]).toBeNull();
  });
});
```

The chauffeur dates are malformed-date-safe literals that only exercise schema rejection, and the
estimate doesn't judge past dates, so they are not date bombs. If
`web-tests/unit/no-date-bombs.test.js` or an API equivalent flags them, switch them to
`futureIsoDate(30)` and `futureIsoDate(31)` from `api/src/testSupport/dates.ts`.

- [ ] **Step 6: Run and see them fail**

Run: `cd api && npx vitest run src/routes/quote.test.ts -t "route choice"`
Expected: FAIL. The first test gets 400, because the strict leg schema rejects `routeVariant`.

- [ ] **Step 7: Implement.**

`api/src/quote/webQuoteV2.ts`: the private leg object becomes

```ts
            .object({
              from: Place,
              to: Place,
              // Customer route choice (spec 2026-09-26 §4.1): ASK for a road, never send a distance.
              routeVariant: z.enum(ROUTE_VARIANTS).optional(),
            })
            .strict(),
```

Add `import { ROUTE_VARIANTS } from './routeChoice';`. The chauffeur `travelDays` object is
unchanged, so `routeVariant` there is still a strict-schema 400.

`api/src/routes/quote.ts`:

```ts
import { cheaperRouteChoice, measureLeg, type RouteChoice, type RouteVariant } from '../quote/routeChoice';

export interface ResolvedLeg { from: string; to: string; distanceKm: number; durationMin: number; routeVariant?: RouteVariant }
```

In `engineRequestFor`, the private branch measures through `measureLeg`:

```ts
  if (intent.product === 'private') {
    const resolved = await Promise.all(
      intent.legs.map(async (leg) => ({ leg, distance: await measureLeg(maps, leg.from, leg.to, leg.routeVariant) })),
    );
    if (resolved.some(({ distance }) => !distance)) return null;
    const estimated = resolved.some(({ distance }) => distance!.estimated === true);
    const legs: ResolvedLeg[] = resolved.map(({ leg, distance }) => ({
      from: leg.from,
      to: leg.to,
      distanceKm: distance!.km,
      durationMin: distance!.durationMin,
      // Echoed ONLY when asked, so every existing caller's response is byte-identical.
      ...(leg.routeVariant ? { routeVariant: distance!.variant } : {}),
    }));
    // … the returned object is unchanged (request.legs maps { from, to, distanceKm })
```

Add a helper below `engineRequestFor` (exported for the batch and for tests):

```ts
// `compareRoutes` is a request FLAG, not part of the intent: lifted off the body before
// WebQuoteIntentSchema (.strict) parses it — exactly as promoCode is — so it never enters an
// intent fingerprint or a locked quote. Allowed only on a one-leg private intent (ops GC-10).
export function liftCompareRoutes(raw: unknown): { body: unknown; compare: boolean; bad: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { body: raw, compare: false, bad: false };
  const { compareRoutes, ...rest } = raw as Record<string, unknown>;
  if (compareRoutes === undefined) return { body: rest, compare: false, bad: false };
  return { body: rest, compare: compareRoutes === true, bad: compareRoutes !== true };
}

export async function routeChoiceFor(
  intent: WebQuoteIntent,
  resolved: ResolvedIntent,
  maps: MapsAdapter,
  card: RateCard,
): Promise<RouteChoice | null> {
  if (intent.product !== 'private' || intent.legs.length !== 1 || resolved.request.product !== 'private') return null;
  if (resolved.estimated) return null;
  const req = resolved.request;
  const leg = intent.legs[0]!;
  const measured = resolved.legs[0]!;
  // A leg already priced on the LOCAL road has no "fastest" to compare against here.
  if (measured.routeVariant === 'no_tolls') return null;
  return cheaperRouteChoice(
    maps, leg.from, leg.to,
    { km: measured.distanceKm, durationMin: measured.durationMin },
    (km) => quote({ ...req, legs: [{ from: leg.from, to: leg.to, distanceKm: km }] }, card).totalCents,
  );
}
```

In `/v2/estimate`, replace the promo-lifting block's input with the lifted body, and refuse a bad
flag:

```ts
    const lifted = liftCompareRoutes(raw);
    if (lifted.bad) return c.json({ error: 'invalid_request' }, 400);
    let rawPromo: unknown;
    let intentBody: unknown = lifted.body;
    if (lifted.body && typeof lifted.body === 'object' && !Array.isArray(lifted.body)) {
      const { promoCode, ...rest } = lifted.body as Record<string, unknown>;
      rawPromo = promoCode;
      intentBody = rest;
    }
    const parsed = WebQuoteIntentSchema.safeParse(intentBody);
    if (!parsed.success) { /* unchanged */ }
    if (lifted.compare && (parsed.data.product !== 'private' || parsed.data.legs.length !== 1)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
```

After `const result = quote(resolved.request, card);`, compute
`const routeChoice = lifted.compare ? await routeChoiceFor(parsed.data, resolved, deps.maps, card) : null;`.
Add `...(routeChoice ? { routeChoice } : {})` to the 200 body.

In `/v2/estimate-batch`, per intent:

```ts
        // (declared once, above the Promise.all: `let compareSlots = MAX_COMPARE_PER_BATCH;`)
        const lifted = liftCompareRoutes(raw);
        if (lifted.bad) return null;
        const parsed = WebQuoteIntentSchema.safeParse(lifted.body);
        if (!parsed.success || parsed.data.product !== 'private') return null;
        if (lifted.compare && parsed.data.legs.length !== 1) return null;
        if (!parsed.data.legs.every((l) => isCatalogTown(l.from) && isCatalogTown(l.to))) return null; // unchanged
        // Claim a comparison slot NOW — after the (synchronous) catalogue check, before this
        // intent's first await (engineRequestFor): slots go to catalogue intents in request order.
        const compare = lifted.compare && compareSlots-- > 0;
        // … engineRequestFor(parsed.data, maps), estimated → null (unchanged)
        const result = quote(resolved.request, card);
        const routeChoice = compare ? await routeChoiceFor(parsed.data, resolved, maps, card) : null;
        return { totalCents: result.totalCents, currency: result.currency, ...(routeChoice ? { routeChoice } : {}) };
```

`/v2/lock` and `PUT /v2/:id`: right after each successful `WebQuoteIntentSchema` parse, refuse a road
(spec §4.1 covers the estimate only; a lock converts via `quoteToBooking`, which has no road):

```ts
// A locked web quote converts to a booking through quoteToBooking, which has no road field —
// it would charge the local-road price and tell ops nothing. Estimate-only until that carries it.
function carriesRoad(intent: WebQuoteIntent): boolean {
  return intent.product === 'private' && intent.legs.some((l) => l.routeVariant !== undefined);
}
// /v2/lock, after its intent parse:
if (carriesRoad(parsed.data)) return c.json({ error: 'route_choice_not_supported' }, 400);
// PUT /v2/:id, after its V2UpdateSchema parse:
if (carriesRoad(parsed.data.intent)) return c.json({ error: 'route_choice_not_supported' }, 400);
```

(Use the right variable per handler: `/v2/lock` parses the intent directly; `PUT` parses
`V2UpdateSchema`, whose intent is `parsed.data.intent`. Read both handlers first. The PUT test above
must copy the exact auth header the existing PUT tests send; find it with
`grep -n "v2/\${" api/src/routes/quote.test.ts`.)

`api/src/routes/bookings.ts` `memoizeDistance` shares one comparison per pair per request:

```ts
export function memoizeDistance(maps: MapsAdapter): MapsAdapter {
  const cache = new Map<string, Promise<DistanceResult | null>>();
  const variants = new Map<string, Promise<RouteVariants | null>>();
  return {
    provider: maps.provider,
    places: (q) => maps.places(q),
    distanceVariants(from, to) {
      const key = `${from}|${to}`;
      let hit = variants.get(key);
      if (!hit) {
        hit = maps.distanceVariants(from, to);
        variants.set(key, hit);
        // A rejected comparison must not poison the request: drop it so a retry can ask again.
        hit.catch(() => variants.delete(key));
      }
      return hit;
    },
    distance(from, to) { /* unchanged */ },
  };
}
```

Add `RouteVariants` to the adapter type import. Update the comment above it in one line: "…and
the route-choice comparison, so an estimate that measures and compares one pair bills it once."

- [ ] **Step 8: Run the route tests green, then the whole API gate**

Run: `cd api && npx vitest run src/routes/quote.test.ts src/quote/routeChoice.test.ts`
Expected: PASS.
Then run the API gate from Global Constraints. Expected: `npm run check` exits 0, with its own
"Test Files … passed" line.

- [ ] **Step 9: Commit and open the PR**

```bash
cd <wt> || exit 1
G=/Library/Developer/CommandLineTools/usr/bin/git
[ "$($G branch --show-current)" = rc/1-api ] || exit 1
$G add api/src/quote/routeChoice.ts api/src/quote/routeChoice.test.ts api/src/quote/webQuoteV2.ts api/src/routes/quote.ts api/src/routes/quote.test.ts api/src/routes/bookings.ts
$G commit -m "feat(quote): price the toll-free road on request, and compare both roads (route choice 1/5)"
```

Open the PR against `main`, since this is the bottom of the stack.

---

### Task 2: Booking API carries, stores and shows the road

**Branch:** `rc/2-booking-api` off `rc/1-api`.

**Files:**
- Modify: `api/src/domain/singleTransfer.ts:82-97` (`routeVariant`)
- Modify: `api/src/domain/trip.ts:13-29` (`routeVariants`)
- Modify: `api/src/services/pricing.ts:72-157` (`priceSingle`, `priceTrip`)
- Modify: `api/src/routes/bookings.ts` (`/single` ≈445-525, `/trip` ≈527-615)
- Create: `api/drizzle/0059_route_variant.sql` and add a journal entry to
  `api/drizzle/meta/_journal.json`. Re-check that `0059` is still free on `origin/main` at build
  time; if it isn't, take the next number and rename everything that follows.
- Modify: `api/src/db/schema.ts:98-115, 271-287`
- Modify: `api/src/db/postgresBookingRepo.ts` (read ≈198-250, insert ≈414-455)
- Modify: `api/src/services/notifications.ts:139-190` (`factRows`) and add `roadRow()`
- Modify: `api/src/routes/ops-ui.html` (`legsHtmlFor` ≈3425, `renderSheet` Trip block ≈3857)
- Tests:
  - `api/src/services/pricing.test.ts` (create it if absent) and `api/src/routes/bookings.test.ts`
  - `api/src/routes/trip.test.ts`
  - `api/src/db/routeVariantMigration.test.ts` (new) and `api/src/db/postgres.test.ts`
  - `api/src/services/notifications.test.ts` and `api/src/services/opsNotifications.test.ts`,
    or whichever files already test `factRows` and `teamPaidEmail`; find them with `grep -l`.

**Interfaces:**
- Consumes: `measureLeg`, `RouteVariant`, `ROUTE_VARIANTS` from Task 1.
- Produces:
  - HTTP `POST /bookings/single` accepts `routeVariant?: 'fastest' | 'no_tolls'`.
  - HTTP `POST /bookings/trip` accepts `routeVariants?: ('fastest' | 'no_tolls')[]`, one entry per
    consecutive stop pair.
  - Error: `422 { error: 'route_choice_unavailable', message: ROUTE_CHOICE_UNAVAILABLE_MESSAGE }`.
  - `Booking.input.routeVariant` (single) and `Booking.input.routeVariants` (trip) read back from
    Postgres.
  - `roadRow(booking): [string, string] | null` in `notifications.ts`.

**Copy, verbatim:**
- `ROUTE_CHOICE_UNAVAILABLE_MESSAGE` = "The local road isn't available for this trip right now, so
  nothing was charged. We've switched the price back to the expressway. Please check it and book
  again."
- Email and ops row, single: label `Road`, value `Local road, no expressway` plus
  ` · about {duration}` when `durationMin` is known, using the existing minutes formatter in
  `notifications.ts` if there is one, else `{h}h {m}m`.
- Email and ops row, trip: label `Road`, value
  `Local road for {A → B}, {C → D}`, using `shortPlace` names.
- Ops sheet trip leg suffix: ` · local road`.

- [ ] **Step 1: Write the failing tests.**

1. **`priceSingle` / `priceTrip`.** Use the stub adapter shape from Task 1 (copy it, don't import
   it across test files).
   - A single with `routeVariant: 'no_tolls'` on a fork prices at the toll-free km: `totalCents`
     equals the engine's car price at 213 km.
   - Without a fork it throws `InvalidPricingRequestError` with `code === 'route_choice_unavailable'`.
   - `'fastest'` or absent behaves exactly as today.
   - A trip `['Colombo Airport (CMB)','Ella','Yala']` with `routeVariants: ['no_tolls','fastest']`
     prices leg 0 at 213 km and leg 1 at the stub's fastest km.
   - A trip whose `no_tolls` pair has no fork throws `route_choice_unavailable`.
2. **Routes**, `bookings.test.ts` / `trip.test.ts` style, with `futureIsoDate()` dates:
   - `POST /bookings/single` with `routeVariant: 'no_tolls'` returns 201. `bookings.get(id)` gives
     `input.routeVariant === 'no_tolls'` and `distanceKm === 213`, `durationMin === 374`.
   - A single with no fork returns 422 with `{ error: 'route_choice_unavailable', message: ROUTE_CHOICE_UNAVAILABLE_MESSAGE }`,
     and **no booking is created** (repo list length unchanged).
   - A trip with `routeVariants` of the wrong length returns 400 `invalid_request`.
   - A chauffeur trip with any `'no_tolls'` returns 400 `invalid_request`.
   - A valid private trip returns 201 and round-trips `routeVariants`.
3. **Migration test** `api/src/db/routeVariantMigration.test.ts`, in the style of
   `paymentEventIdempotencyMigration.test.ts`:
   - The SQL adds `"route_variant" text` to `"transfer_request"` and `"route_variants" text[]` to
     `"trip_request"`, both nullable.
   - It contains no `insert|update|delete`.
   - It is journalled directly after `0058_booking_status_events` with a larger `when`.
4. **Postgres round trip** (`postgres.test.ts`, DB-gated): extend the single sample with
   `routeVariant: 'no_tolls'` in a new `it` and the trip with `routeVariants: ['no_tolls','fastest']`,
   and assert both read back. Also assert a booking without them reads back with the keys absent,
   not `null`.
5. **Emails.**
   - `factRows` for a single with `routeVariant: 'no_tolls'`, `durationMin: 374` includes
     `['Road', 'Local road, no expressway · about 6h 14m']`.
   - The trip case includes `['Road', 'Local road for Colombo Airport (CMB) → Ella']`, using
     whatever `shortPlace` returns; assert with `shortPlace()` itself.
   - Without a road there is no `Road` row.
   - `teamPaidEmail` for the single has the Road row in its HTML body, and its **subject is
     byte-identical** to the same booking without a road.

- [ ] **Step 2: Run and see them fail.**
Run: `cd api && npx vitest run src/services src/routes/bookings.test.ts src/routes/trip.test.ts src/db/routeVariantMigration.test.ts`
Expected: FAIL. The unknown key is silently stripped, the migration file is missing, and there is
no Road row.

- [ ] **Step 3: Implement.**

`singleTransfer.ts`: add `routeVariant: z.enum(ROUTE_VARIANTS).optional(),` to
`SingleTransferInput`, importing from `../quote/routeChoice`. `trip.ts`: add
`routeVariants: z.array(z.enum(ROUTE_VARIANTS)).max(MAX_TRIP_STOPS - 1).optional(),`. The length
check is in the handler, so `TripInput` stays a plain `ZodObject`. The spec allowed `null`
entries. This plan uses `'fastest'` for "no choice" and for gap wires, which prices identically
and keeps the column a plain `text[]` with no NULL elements.

`pricing.ts`:

```ts
import { measureLeg } from '../quote/routeChoice';

export const ROUTE_CHOICE_UNAVAILABLE = 'route_choice_unavailable';

// priceSingle
  let distance = null;
  try {
    distance = await measureLeg(maps, input.from, input.to, input.routeVariant);
  } catch {
    distance = null;
  }
  if (!distance) return unpriced(`distance unresolved: ${input.from} → ${input.to}`);
  if (distance.estimated) return unpriced(`${ESTIMATED_DISTANCE}: ${input.from} → ${input.to}`);
  // A booking NEVER silently switches road (spec §4.2): the customer saw the local-road price.
  if (input.routeVariant === 'no_tolls' && distance.variant !== 'no_tolls') {
    throw new InvalidPricingRequestError(ROUTE_CHOICE_UNAVAILABLE);
  }
  // … runEngine unchanged, distanceKm: distance.km
```

In `priceTrip`'s loop, `leg = await measureLeg(maps, from, to, input.routeVariants?.[i]);`. After
the estimated check, add
`if (input.routeVariants?.[i] === 'no_tolls' && leg.variant !== 'no_tolls') throw new InvalidPricingRequestError(ROUTE_CHOICE_UNAVAILABLE);`.

`bookings.ts`:
- Import `ROUTE_CHOICE_UNAVAILABLE` and `measureLeg`.
- Add
  `const ROUTE_CHOICE_UNAVAILABLE_MESSAGE = "The local road isn't available for this trip right now, so nothing was charged. We've switched the price back to the expressway. Please check it and book again.";`
- In both `catch (err)` blocks around `priceSingle` / `priceTrip`:

  ```ts
      if (err instanceof InvalidPricingRequestError) {
        return c.json(err.code === ROUTE_CHOICE_UNAVAILABLE
          ? { error: err.code, message: ROUTE_CHOICE_UNAVAILABLE_MESSAGE }
          : { error: err.code }, 422);
      }
  ```

- In `/single`, the M8 enrichment measures the same road that was priced:
  `distance = await measureLeg(legMaps, parsed.data.from, parsed.data.to, parsed.data.routeVariant);`.
  The memoized adapter makes this free. The `booking.create` call already stores
  `distanceKm: distance?.km`; keep that shape.
- In `/trip`'s M8 enrichment loop (≈580-596), measure the road that was priced:
  `const leg = await measureLeg(legMaps, stops[i], stops[i + 1], parsed.data.routeVariants?.[i]);`.
  Otherwise the stored trip km and minutes would be the expressway's.
- In `/trip`, right after `safeParse` succeeds:

  ```ts
    const rv = parsed.data.routeVariants;
    if (rv && (rv.length !== parsed.data.stops.length - 1 || (parsed.data.serviceType === 'chauffeur' && rv.includes('no_tolls')))) {
      return c.json({ error: 'invalid_request' }, 400);
    }
  ```

Migration `api/drizzle/0059_route_variant.sql`:

```sql
-- Customer route choice (spec docs/superpowers/specs/2026-09-26-customer-route-choice-design.md §4.2).
-- The road the customer paid for, so ops can brief the driver. Additive, nullable, no backfill:
-- null means the customer never chose, which is the expressway (today's behaviour). A nullable
-- ADD COLUMN takes no rewrite and no long lock on Postgres 11+.
ALTER TABLE "transfer_request" ADD COLUMN IF NOT EXISTS "route_variant" text;
--> statement-breakpoint
ALTER TABLE "trip_request" ADD COLUMN IF NOT EXISTS "route_variants" text[];
```

Journal entry: `{ "idx": 59, "version": "7", "when": 1790640000000, "tag": "0059_route_variant", "breakpoints": true }`.
Use `when` = 0058's `when` + 86400000. Hand-write it; `drizzle-kit generate` is broken past 0024.

`schema.ts`: `routeVariant: text('route_variant'),` on `transferRequests`;
`routeVariants: text('route_variants').array(),` on `tripRequests`.

`postgresBookingRepo.ts`:
- Insert `routeVariant: t.routeVariant ?? null` and `routeVariants: t.routeVariants ?? null`.
- Read back with `...(t.routeVariant ? { routeVariant: t.routeVariant as RouteVariant } : {})` and
  `...(tr.routeVariants ? { routeVariants: tr.routeVariants as RouteVariant[] } : {})`, so old rows
  stay byte-identical.

`notifications.ts`:

```ts
// The road the customer paid for, when it isn't the expressway (spec §4.3). Null otherwise, so
// every existing booking's emails are unchanged.
export function roadRow(booking: Booking): [string, string] | null {
  if (booking.mode === 'single' && booking.input.routeVariant === 'no_tolls') {
    const t = booking.durationMin ? ` · about ${hoursMinutes(booking.durationMin)}` : '';
    return ['Road', `Local road, no expressway${t}`];
  }
  if (booking.mode === 'trip' && booking.input.routeVariants?.includes('no_tolls')) {
    const s = booking.input.stops;
    const legs = booking.input.routeVariants
      .map((v, i) => (v === 'no_tolls' && s[i + 1] ? `${shortPlace(s[i]!)} → ${shortPlace(s[i + 1]!)}` : null))
      .filter(Boolean);
    return legs.length ? ['Road', `Local road for ${legs.join(', ')}`] : null;
  }
  return null;
}
```

`hoursMinutes(min)` gives `6h 14m`, or `6h` when minutes are 0. Reuse an existing formatter in the
file if there is one with that exact output; otherwise add this small private function.
`factRows`:
- The single branch pushes `roadRow(booking)` right after its date row when non-null.
- The trip branch pushes it after `Dates`.

The team emails use `factRows` through `bookingFacts`, so the "Paid:" body gets it with no
subject change. Don't touch `routeText`, `bookingFacts.subjectRoute` or `route()`.

`ops-ui.html`:
- In `legsHtmlFor`, build each row as
  ``${esc(when)} · ${esc(stops[i])} → ${esc(stops[i+1])}${(b.input.routeVariants||[])[i]==='no_tolls'?' · local road':''}``.
- In `renderSheet`'s Trip block, right after the Route kv row, add
  ``${d?.booking?.mode==='single'&&d.booking.input?.routeVariant==='no_tolls'?`<div class="kv"><span class="k">Road</span><span class="v">Local road, no expressway</span></div>`:''}``.
  Confirm `d` is in scope there, as `legsHtmlFor(d)` is called in the same template. If it isn't,
  use the variable that holds the detail payload.

- [ ] **Step 4: Run the new tests green; then the full API gate** (throwaway DB, Global
  Constraints). Then run the web gate as well, because `ops-ui.html` changed and web-tests may
  extract functions from it.

- [ ] **Step 5: Verify the ops sheet in a browser.** Start the API locally with the fake maps.
  Create a single booking with `routeVariant:'no_tolls'` for `Colombo City → Ella` through `curl`
  to `localhost:8787`; `FAKE_VARIANT_PAIRS` has that pair. Open it in `/ops`, take a screenshot of
  the Road row, and attach it to the PR.
  - **Fake-only oddity, not a bug:** the fake's `distance()` is crow-flies × 1.35, 179 km, while
    its scripted `noTolls` is 205 km, so this dev booking prices the local road *higher*. The
    check is for display only. Don't change the fake.
  - If the local ops login can't be reached, say so in the PR instead.

- [ ] **Step 6: Commit** in two commits:
  1. The domain, pricing, route, migration, schema and repo files, with the message
     `feat(bookings): carry and store the customer's road (route choice 2/5)`.
  2. The emails and ops sheet, with the message `feat(ops,email): show the local road to ops and
     the customer`.

  Open the PR with base `rc/1-api`. The body carries the full migration SQL under the heading
  **"Migration — needs owner OK before merge"**. It says that a nullable add takes no lock and
  that nothing writes the columns until this PR's code ships. The body also flags:
  - `api/src/services/pricing.ts`, the booking pricing path, changed;
  - `factRows` feeds every customer email that shows trip facts, not only the confirmation. List
    them from `grep -n "factRows\|detailsRow" api/src/services/*.ts`;
  - the Road copy differs from spec §4.3's "By the local road · about 6h 45m": one line now
    serves ops and customers. This needs owner copy sign-off.

---

### Task 3: Booking page reads, sends and shows the road

**Branch:** `rc/3-booking-page` off `rc/2-booking-api`.

**Files:**
- Modify: `booking.js`, as follows.
  - The parameters at ≈136-175: add the `road` and `roads` parsing.
  - `buildEstimateIntent` at ≈1440-1478: legs carry `routeVariant`.
  - `handleEngineEstimate` at ≈1661: handle the echo.
  - `paintCustomerRouteEstimate` at ≈1880: the road line.
  - The map at ≈600-640: the `runs` option.
  - `createApiBooking` at ≈2706-2790: the payload fields.
  - The plan edit URL at ≈679: carry `roads`.
  - The booking-error handler that calls `bookingCreateFailure`: find it with
    `grep -n bookingCreateFailure booking.js`.
- Modify: `booking.html` near `#sum-route-estimate` (≈1004). Add
  `<p class="s-road" id="sum-road" hidden></p>` and
  `<p class="s-road-note" id="sum-road-note" role="status" hidden></p>`, with small inline styles
  in booking.html's existing `<style>` block that match `.s-estimate`.
- Test: `web-tests/e2e/booking-route-choice.spec.js` (new).

**Interfaces:**
- Consumes:
  - URL `road=no_tolls` on `mode=private`, from Task 4.
  - URL `roads=` on `mode=trip`: a comma list index-aligned with `stops` pairs, `no_tolls` or
    empty, from Task 5.
  - The estimate echo `legs[i].routeVariant`, and the `route_choice_unavailable` 422 from Tasks 1
    and 2.
- Produces: the `routeVariant` and `routeVariants` request fields. It also puts `roads=` into
  `tripEditUrl` so going back to plan keeps the choices.

**Copy, verbatim:**
- Summary line, single: `Via the local road · no expressway`.
- Summary line, trip: `Local road for {A → B}, {C → D}`, using `shortPlaceLabel`.
- Echo notice: `The local road isn't available for these exact points, so this is the expressway fare.`
- Chauffeur notice: `Local roads apply to private transfers, so a chauffeur-guide takes the usual roads.`

Steps:

- [ ] **Step 1: Write the failing e2e spec.** Use `web-tests/e2e/_stubs.js`
  `installEstimateStub`, and `gotoBooking` like `search-engine-price.spec.js`. The stub `respond`
  echoes `routeVariant` per leg, returns `distanceKm` 213 for a `no_tolls` leg and 335 otherwise,
  and prices `totalCents = distanceKm * 42`.
  1. `booking.html?mode=private&from=cmb-airport&to=ella&vehicle=car&price=89.46&road=no_tolls&estimateKm=213&estimateMin=374`:
     the first captured estimate intent has `legs[0].routeVariant === 'no_tolls'`, and `#sum-road`
     shows the single copy.
  2. The same URL with a stub that echoes `routeVariant:'fastest'`: `#sum-road` is hidden,
     `#sum-road-note` shows the echo notice, and the next intent has no `routeVariant`.
  3. Intercept `POST **/bookings/single` and complete the booking form. Follow the steps an
     existing booking e2e spec already uses, found with
     `grep -l "bookings/single" web-tests/e2e`. The captured body has `routeVariant:'no_tolls'`.
  4. `mode=trip&stops=Colombo Airport (CMB)|Ella|Yala&nights=0,1,0&roads=no_tolls,&pax=2&vehicle=car`:
     - The first intent's legs are `[{…,routeVariant:'no_tolls'},{from:'Ella',to:'Yala'}]`.
     - The captured `/bookings/trip` body has `routeVariants:['no_tolls','fastest']`.
     - `#sum-road` shows `Local road for …`.
  5. The same trip after choosing Chauffeur-guide: no `routeVariants` in the body, and the
     chauffeur notice is visible.
  6. A 422 `{error:'route_choice_unavailable', message:'X'}` from `/bookings/single`:
     - The customer sees `X`.
     - The next estimate intent has no `routeVariant`.
     - `#sum-road` is hidden.

- [ ] **Step 2: Run and see it fail**
  (`npx --prefix <abs>/web-tests playwright test e2e/booking-route-choice.spec.js`, foreground,
  `timeout: 600000`).

- [ ] **Step 3: Implement** in `booking.js`.
  - **Parsing.** Add `let bookRoad=null, tripRoads=[], roadNotice='';`.
    - Single, when `mode==='private'`:
      `bookRoad = params.get('road')==='no_tolls' ? 'no_tolls' : null;`.
      When `bookRoad` is set and the pair is a catalogue pair, seed `vehPrices` from the passed
      local-road km instead of the expressway catalogue:
      `const k=positiveNumberParam('estimateKm'); if(bookRoad && k) vehPrices={ car:T.legPrice(k,'car'), van:T.legPrice(k,'van') };`.
      Put this right after the existing `vehPrices` block. `positiveNumberParam` is defined
      below; if it's hoisted as a function declaration that's fine, otherwise inline the parse.
    - Trip:
      `tripRoads=(params.get('roads')||'').split(',').map(s=>s.trim()==='no_tolls'?'no_tolls':'fastest');`.
  - **Helper.** `function tripRoadAt(i){ return state.svc==='chauffeur' ? 'fastest' : (tripRoads[i]||'fastest'); }`
  - **`buildEstimateIntent`.**
    - Trip-private legs push
      `Object.assign({ from: tripStops[i], to: tripStops[i+1] }, tripRoadAt(i)==='no_tolls' ? { routeVariant:'no_tolls' } : {})`.
    - The single leg gets `routeVariant:'no_tolls'` when `bookRoad==='no_tolls'`.
    - Chauffeur is unchanged.
  - **`handleEngineEstimate(est, sig)`.** At its top, when `sig===currentIntentSig()` and
    `est.legs` is an array:
    - For the single, if `bookRoad==='no_tolls'` and `est.legs[0]?.routeVariant==='fastest'`, set
      `bookRoad=null`, `roadNotice='echo'`, and fall through.
    - For the trip, map each estimate leg back to its wire. The estimate skips gap wires, so walk
      `i` over wires and skip `tripGaps`. Any wire that asked for `no_tolls` and got `fastest` is
      set to `'fastest'`, also with `roadNotice='echo'`.
    - Then, right after clearing the road, take `const sigNow = currentIntentSig();` once. Use
      `sigNow` in place of `sig` for **every** later use of the signature in
      `handleEngineEstimate`:
      - `adoptCustomerRouteEstimate`;
      - the `customerDroveTheRaise` comparison;
      - the `pendingReprice = {…, sig}` it may park, since accepting it later calls
        `adoptEngineEstimate(p.est, p.sig)` at ≈1192;
      - `adoptEngineEstimate`.

      An echoed `fastest` is exactly the expressway price for the new intent. `render()` will
      still send one more estimate for the new intent, because `lastRequestedSig` holds the old
      one. Don't suppress it: e2e test 2 relies on it.
  - **`paintCustomerRouteEstimate`.** Also paints `#sum-road`:
    - Single with `bookRoad`: the single copy.
    - Trip: the trip copy built from `tripStops` and the `no_tolls` indices of `tripRoads`, only
      while `state.svc!=='chauffeur'`.
    - Otherwise hidden.

    It also paints `#sum-road-note` from `roadNotice`: `'echo'` gives the echo notice. When
    `state.svc==='chauffeur'` and `tripRoads.includes('no_tolls')`, it shows the chauffeur notice.
  - **Map.** In the single map call, when `bookRoad==='no_tolls'`, add
    `runs:[{ stops:[pFrom,pTo], avoidTolls:true, continues:false }]` to the options. If the trip
    map is drawn with `CH_MAP.renderRoute` (grep), split its runs by road the way
    `api/src/quote/customerQuoteView.ts:198-222` `mapRunsOf` does. Otherwise leave the trip map
    alone and note that in the PR.
  - **`createApiBooking`.**
    - The single payload gets `routeVariant: bookRoad==='no_tolls' ? 'no_tolls' : undefined`.
    - The trip payload gets
      `routeVariants: (state.svc!=='chauffeur' && tripRoads.includes('no_tolls')) ? tripStops.slice(1).map((_,i)=>tripRoadAt(i)) : undefined`.
    - The idempotency key derives from the payload, so a changed road mints a new key. That is
      correct.
  - **Error path.** Where a failed `createApiBooking` is caught, if
    `err.status===422 && err.body && err.body.error==='route_choice_unavailable'`:
    - Clear the road: `bookRoad=null; tripRoads=tripRoads.map(()=> 'fastest');`.
    - Set `roadNotice=''` and call `render()`.
    - Show the message **without an immediate retry button**: `phShowEnd('error', err.body.message, {retry:false})`.
      Check `phShowEnd`'s signature, around ≈2571. The customer has to see the new price and press
      Pay again; a one-click retry would skip that review.
  - **`tripEditUrl`** (≈679) is built once at init. Move its construction into a small
    `buildTripEditUrl()`. The "Edit this itinerary" button bakes the URL into an inline `onclick`
    (≈682), and "← Back to planner" captures `datesUrl` in a closure (≈692); `grep tripEditUrl`
    finds neither. Change both to call `buildTripEditUrl()`, or a `datesUrl` variant of it, **at
    click time**. It adds
    `roads: tripRoads.some(v=>v==='no_tolls') ? tripRoads.map(v=>v==='no_tolls'?'no_tolls':'').join(',') : ''`
    and drop the key when it's empty.

- [ ] **Step 4: Stamp and run.** Run `npm run stamp` at the worktree root, then the new spec green,
  then the full web gate.
- [ ] **Step 5: Browser check.** Open the single URL from test 1 on a local static server in the
  browser pane and take a screenshot of the summary with the road line. The local preview cannot
  reach the prod API because of CORS, so the price stays on its local figure. That's expected;
  the screenshot is for the copy and layout.
- [ ] **Step 6: Commit** `booking.js booking.html web-tests/e2e/booking-route-choice.spec.js`
  plus any restamped pages, with the message
  `feat(booking): carry the chosen road into pricing and the booking (route choice 3/5)`. Open the
  PR with base `rc/2-booking-api`.

---

### Task 4: Route-choice popup, search page, and analytics

**Branch:** `rc/4-search` off `rc/3-booking-page`.

**Files:**
- Create: `route-choice.js` (repo root, a classic script, `window.CH_ROUTE_CHOICE`)
- Create: `web-tests/unit/route-choice.test.js` (jsdom)
- Modify: `search.html`. Load `route-choice.js` before `search.js`, stamped.
- Modify: `search.js`:
  - `ask()` and the engine block at ≈737-819.
  - `privateCardHtml` at ≈290-318.
  - `renderMeta` at ≈190-205.
  - `bookUrl` at ≈258-276.
  - A new `roads` state near `quote`.
- Modify: `web-tests/e2e/_stubs.js` `installEstimateStub` (≈125-148), a **shared test helper**
  to flag in the PR. It passes through any extra keys the `respond`, `sequence` or `single`
  object returns, `routeChoice` among them: destructure `...rest` and spread it into the fulfilled
  JSON. Existing specs are unaffected because they return no extra keys.
- Modify: `tools/analytics/build-gtm-missing-tags.mjs` (`EVENTS`). Regenerate
  `docs/analytics/gtm-missing-tags.json` with the command in that script's header comment.
- Test: `web-tests/e2e/search-route-choice.spec.js` (new)

**Interfaces:**
- Produces `window.CH_ROUTE_CHOICE`, which Task 5 consumes:

```js
CH_ROUTE_CHOICE.open({
  title,            // 'Two roads to Ella'
  sub,              // one sentence under the title
  fastest: { time: '5h', km: '335 km', price: '$140', extra: 'van $189' },
  local:   { time: '6h 14m', slower: '+1h 15m', km: '213 km', price: '$91', extra: 'van $123', save: 'Save $49' },
  selected: 'fastest' | 'no_tolls',
  onPick(variant),  // 'fastest' | 'no_tolls' — the primary button
  onDismiss(),      // Decide later, ×, Escape, scrim
}) → void
CH_ROUTE_CHOICE.isOpen() → boolean
CH_ROUTE_CHOICE.wasAsked(key) → boolean      // sessionStorage 'chRoadAsked:'+key, try/catch
CH_ROUTE_CHOICE.markAsked(key) → void
CH_ROUTE_CHOICE.fmtMinutes(min) → '6h 14m' | '5h' | '45 min'
```

- Consumes: `routeChoice` in the estimate response (Task 1), and `road=no_tolls` on booking
  (Task 3).
- Analytics event `route_choice` with `{ choice: 'fastest'|'no_tolls'|'dismissed', source: 'popup'|'card', page: 'search'|'plan', saving_usd: number }`.

**Copy, verbatim:**
- Title: `Two roads to {to}`, with `{to}` the destination's display name.
- Sub: `The local road skips the expressway tolls. It's slower, but cheaper. Pick one and you can switch later.`
- Expressway card:
  - Name `Expressway` and tag `Fastest`.
  - Stats `{km} · tolls included · {extra}`.
  - Best-for line `Best for a flight or a tight schedule`.
- Local card:
  - Name `Local road` and tag `{save}`.
  - Stats `{km} · no tolls · {extra}`.
  - Best-for line `Best if you'd rather pay less`.
- Buttons: `Decide later`, and `Use expressway` or `Use local road` to match the selected card.
- Close button `aria-label="Close"`.
- Card switch labels: `Expressway · {time}` / `Local road · {time}`, inside a `role="radiogroup"`
  with `aria-label="Road"`.
- Meta line suffix when local: ` · via local road`.

**Component rules** (spec §4.5):
- Styles are injected once into `<head>` as a `<style id="ch-rc-style">`, the way `ch-map.js`
  `ensureStyle` does.
- Structure:
  - Scrim: `position:fixed; inset:0; z-index:500`.
  - Dialog: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the title id.
- Layout:
  - Desktop, from 640 px wide: a centred card, `max-width:560px`, with the two option cards
    stacked.
  - Phone, below 640 px: a bottom sheet, `position:fixed; left:0; right:0; bottom:0`, with a
    top-rounded 22px radius and a slide-up
    `transform:translateY(102%)` → `0`, `transition:transform .28s`. The transition is removed
    under `@media (prefers-reduced-motion: reduce)`.
- Colours: blue `#2F6DB5` for the expressway swatch and amber `#D9861A` (dashed) for the local
  swatch, kept off the brand teal. Surfaces use `var(--paper,#fffdf8)`, `var(--ink,#3A3739)` and
  `var(--line,#e7e3d6)`. The primary button uses `var(--btn-accent,#24758A)` with white text.
- The option cards are `<label>`s wrapping `<input type="radio" name="ch-rc-road">`, so the arrow
  keys work natively. Changing the selection updates the primary button text.
- Focus:
  - On open: remember `document.activeElement` and focus the checked radio.
  - Lock scrolling with `document.body.style.overflow='hidden'` and restore the previous value on
    close.
  - Escape, the ×, the scrim, and "Decide later" call `onDismiss`. The primary button calls
    `onPick(selected)`. Every close restores focus. There is no focus trap, following
    `ch-map.js` `openExpanded`.
- `open()` while already open does nothing: it never stacks.

Steps:

- [ ] **Step 1: Failing unit test** `web-tests/unit/route-choice.test.js` (jsdom; load the script
  with `new Function(src)()` against `window` as other unit tests load root scripts, found with
  `grep -l "readFileSync(.*\.js" web-tests/unit | head`):
  - `open()` renders a dialog with the title, both prices, and the save tag. The expressway radio
    is checked when `selected:'fastest'`, and the primary reads `Use expressway`.
  - Selecting the local radio makes the primary read `Use local road`. Clicking it calls
    `onPick('no_tolls')` once and removes the dialog.
  - Escape calls `onDismiss` once, removes the dialog, and restores focus to the previously
    focused button.
  - A second `open()` while open is ignored (still one dialog).
  - `wasAsked` / `markAsked` round-trip, and `wasAsked` returns false when `sessionStorage`
    throws.
  - `fmtMinutes(374)` returns `'6h 14m'`, `fmtMinutes(300)` returns `'5h'`, and `fmtMinutes(45)`
    returns `'45 min'`.
- [ ] **Step 2: Run it red**
  (`npm --prefix <abs>/web-tests exec vitest run unit/route-choice.test.js`).
- [ ] **Step 3: Implement `route-choice.js`** to those rules. Build DOM nodes or escape every
  interpolated string, because place names come from URLs.
- [ ] **Step 4: Run the unit test green.**
- [ ] **Step 5: Failing e2e** `web-tests/e2e/search-route-choice.spec.js`. Its `installEstimateStub`
  responds:
  - to an intent with `compareRoutes:true` for `cmb-airport → ella` with
    `totalCents` 14000 (car) or 18900 (van), `legs[0]` = 335 km / 299 min, and
    `routeChoice.fastest` = the same with that total;
  - with `routeChoice.noTolls` = 213 km / 374 min and totalCents 9100 (car) or 12300 (van).

  Tests:
  1. `search.html?from=cmb-airport&to=ella`: the dialog opens once, titled `Two roads to Ella`,
     with `Save $49`.
  2. Picking `Use local road` changes the car price to `$91`, the van to `$123`, and the meta line
     to include `213 km` and `via local road`. The car Select href has `road=no_tolls` and
     `estimateKm=213`, and the `route_choice` dataLayer push has `choice:'no_tolls'`.
  3. `Decide later` leaves `$140`, and no `road` appears in the hrefs. A reload in the same tab
     does not reopen the dialog, but the card switch is present.
  4. The card switch changes prices both ways without a new estimate request. Count the stub's
     calls.
  5. A stub without `routeChoice` shows no dialog and no switch.
  6. `blockLiveApi` (catalogue fallback) shows no dialog.
  7. At a 375×812 viewport the dialog is anchored to the bottom: its bounding box bottom is within
     2 px of the viewport height.
  8. Escape closes the dialog.
  9. `search.html?from=cmb-airport&to=ella&road=no_tolls` preselects the local road on the card
     and opens no dialog.
- [ ] **Step 6: Run the e2e red.**
- [ ] **Step 7: Implement in `search.js`.**
  - **Requests.** `ask(vehicle)` sends `Object.assign({ vehicle }, base, { compareRoutes: true })`.
  - **State.**
    - `let roads = null;` holds
      `{ fastest:{km,min,car,van}, noTolls:{km,min,car,van} }` in dollars, like `quote.car`.
    - `let road = params.get('road')==='no_tolls' ? 'no_tolls' : 'fastest';`
    - `let selectClicked = false;`, set by a capture click listener on `#results` for
      `a[href*="booking.html"]`.
  - **When both engine answers land.** In the `ask('car').then(...)` result, when
    `car.routeChoice && van.routeChoice`. In the **baked** branch, do this only *after* its
    `if (settled) return;` guard **and after `quote = tagRouteEstimate(…)` (≈786-790), before
    `showFares()`**, so a catalogue fallback that already showed a fare never gets roads or a
    dialog, and `expresswayQuote` is the engine-priced quote with the catalogue km. In the engine-only branch, do it after `quote` is
    built:
    - Set `roads` from them. The dollars are the engine's `totalCents/100`.
    - If `road==='no_tolls'`, apply the local road before the first priced render with
      `applyRoad('no_tolls', false)`.
    - Leave `roads` null if either vehicle lacks `routeChoice`.
  - **`applyRoad(v, track)`.**
    - Set `road=v`.
    - Keep `const expresswayQuote` = the `quote` object as it stood when `roads` was set. On a
      baked pair its km and minutes are the catalogue's (`search.js:786-790`), not the engine's.
      - `'fastest'` restores exactly that object.
      - `'no_tolls'` sets `quote` =
        `tagRouteEstimate(Object.assign({}, expresswayQuote, { km: roads.noTolls.km, durationMin: roads.noTolls.min, car: roads.noTolls.car, van: roads.noTolls.van, rawCar:null, rawVan:null }), expresswayQuote.estimateState)`.
    - So switching back never changes the expressway's shown km. The popup's expressway km and
      time also come from `expresswayQuote.km` and `expresswayQuote.durationMin`, not
      `roads.fastest`, so the popup and the meta line agree.
    - Replace only `#results .opt-private` with `privateCardHtml()` and call `renderMeta(false)`.
    - Call `showSharedSaving()`, and `showAlreadyGoing()` if `goingList`. Read those two first:
      they must recompute from `quote`. If one of them only ever reveals and never recomputes,
      make it recompute. That is the explicit exception to "a fare once shown never changes"
      (spec §4.6). Put that sentence in a comment where it happens.
    - **Never** call `showFares()` or `trackResults()` here.
    - When `track` is set, `chTrack('route_choice', { choice:v, source:track, page:'search', saving_usd: Math.round(roads.fastest.car-roads.noTolls.car) })`.
  - **`privateCardHtml`.** When `roads` is set, render the radiogroup switch above the vehicle
    rows. Its two buttons use `aria-pressed`, or radios, and call `applyRoad(..., 'card')` through
    a delegated listener on `#results`, not inline `onclick`.
  - **`renderMeta`.** It appends ` · via local road` when `road==='no_tolls'`.
  - **`bookUrl`.** It adds `road:'no_tolls'` when `road==='no_tolls'`. `estimateKm` and
    `estimateMin` already come from `quote`, now the local road's.
  - **`maybeOffer()`.** Call it after the priced render or `showFares()` completes.
    - It returns early if:
      - `!roads`, or `road==='no_tolls'`;
      - `params.has('road')`;
      - `CH_ROUTE_CHOICE.wasAsked(key)` is true, with key `fromP.name+'>'+toP.name`;
      - `document.visibilityState!=='visible'`;
      - `document.activeElement` is inside `#srch-bar`;
      - `selectClicked` is true.
    - Otherwise it calls `markAsked(key)` and `open({...})` with the copy above, formatting prices
      with `displayPrice` and times with `CH_ROUTE_CHOICE.fmtMinutes`. `slower` is
      `'+'+fmtMinutes(noTolls.min - fastest.min)` and `save` is `'Save $'+Math.round(fastest.car-noTolls.car)`.
    - `onPick` calls `applyRoad(v,'popup')`.
    - `onDismiss` calls `chTrack('route_choice',{choice:'dismissed',source:'popup',page:'search',saving_usd})`.
  - **Analytics.** Add `route_choice` to `EVENTS` with its four params and a `why:` line. Then run
    the regeneration so `gtm-event-coverage.test.js` passes.
- [ ] **Step 8: Stamp, run the e2e green, then the full web gate.**
- [ ] **Step 9: Visual check from the e2e run.** The fake maps can't produce a cheaper fork: its
  `distance()` gives 179 km and its `noTolls` 205 km, so a local fake-API check would never show
  the dialog. Instead, add `await page.screenshot({ path: test.info().outputPath('<name>.png') })`
  to e2e tests 1, 2 and 7, for the desktop popup, the card after the pick and the 375 px sheet.
  Copy the PNGs to the session scratchpad, look at each one, and attach them to the PR.
- [ ] **Step 10: Commit** `route-choice.js`, `search.js`, `search.html`, the two tests, the
  analytics script and JSON, and the restamped pages, with the message
  `feat(search): offer the cheaper local road once, and keep a road switch (route choice 4/5)`.
  Open the PR with base `rc/3-booking-page` and attach the screenshots. Flag in the body that
  `route-choice.js` is a **new shared component** loaded on two pages, and that `_stubs.js`
  changed.

---

### Task 5: Plan page — per-drive road choice

**Branch:** `rc/5-plan` off `rc/4-search`.

**Files:**
- Modify: `plan.html`. Load `route-choice.js` before `plan.js`, stamped.
- Modify: `plan.js`.
  - Add `roadChoice`/`roadOptions` state near `liveRouteCache`.
  - Change `legRouteEstimate` at :93.
  - Change `distHtml` at :519-533.
  - Add a `render()` hook at ≈594.
  - Change `routeRuns` and `renderMap` at :1033-1055.
  - Change `goToBooking` at :1369-1397.
  - Change the URL parsing near :173 (`roads`).
  - Change `syncPlanUrl` to keep `roads`.
- Modify: `web-tests/e2e/_stubs.js`. Make **both** `blockLiveApi` (≈104-107) **and** `gotoBooking`'s
  route set (≈185-260) answer `**/quote/v2/estimate-batch` with 404; `smoke.spec.js` opens
  `plan.html` through `gotoBooking`. Then run
  `grep -l "plan.html" web-tests/e2e/*.spec.js | xargs grep -L "blockLiveApi\|gotoBooking"` and add
  `blockLiveApi` to every file it lists. Today that is `live-pricing.spec.js`. In
  `plan-route-choice.spec.js`, call `blockLiveApi` **before** registering its own batch stub:
  Playwright gives the route registered later priority. The new spec also needs
  `page.addInitScript(installStubs)`, so that `__computeRoutesReqs` is recorded. Otherwise, after this task, every plan page load in the
  existing suite would POST a real batch to `ceylon-hop-api.onrender.com`. That breaks the offline
  suite and bills Google. Add one assertion in the new spec that no request goes to `onrender.com`.
- Test: `web-tests/e2e/plan-route-choice.spec.js` (new)

**Interfaces:**
- Consumes:
  - `CH_ROUTE_CHOICE` from Task 4.
  - `POST {CEYLON_HOP_API}/quote/v2/estimate-batch` with `compareRoutes` per intent, from Task 1.
  - `roads=` on the booking page, from Task 3.
- Produces: `roads=` on the booking hand-off and in the plan URL, index-aligned with `stops`
  wires, with `no_tolls` or an empty entry per wire.

**Rules** (spec §4.7):
- **Keys.** Choices are keyed by drive, `liveRouteKey(from,to)`, not by card index. Reordering
  keeps a choice, and changing an endpoint re-arms it because the key changes.
- **State.**
  - `roadOptions: Map<key, {fastest:{km,min}, noTolls:{km,min}}>` holds the batch answer.
  - `roadChecked: Set<key>` holds keys already sent, so the batch never resends them.
  - `roadChoice: Map<key,'no_tolls'|'fastest'>`.
- **`legRouteEstimate(a,b)`.** When `roadChoice.get(key)==='no_tolls' && roadOptions.has(key)`, it
  returns the base estimate with `distanceKm` and `durationMin` replaced by the `noTolls` side and
  `road:'no_tolls'` added. Every price on the page (cards, guide total, `kms` hand-off) flows
  through this function, so nothing else needs its own road logic. `requestLiveRoute` keeps
  reading the base estimate: call the base helper directly there.
- **The batch.**
  - `checkRoads()` is debounced 800 ms and called at the end of `render()`.
  - It collects the transfer legs whose `from` and `to` are non-empty and whose key is not in
    `roadChecked`, de-duplicated and capped at **10**, the spec's maximum drives; the server caps
    comparisons at 12.
  - It POSTs
    `{ intents: legs.map(l => ({ product:'private', vehicle:'car', pax:1, bags:0, extras:[], legs:[{from:l.from,to:l.to}], compareRoutes:true })) }`
    and adds every sent key to `roadChecked`.
  - For each result with `routeChoice` it sets
    `roadOptions.set(key, {fastest:{km:rc.fastest.distanceKm,min:rc.fastest.durationMin}, noTolls:{km:rc.noTolls.distanceKm,min:rc.noTolls.durationMin}})`.
  - Afterwards it calls `render()` if anything was added, then `maybeOfferRoad()`.
  - When the API is off (`!window.CEYLON_HOP_API`), a network error or a non-200, it does nothing
    and leaves no retry loop.
  - A URL `roads=` choice whose drive comes back without `routeChoice` is dropped.
- **Prices on this page are this page's own.** They are `T.finishPrice(legPrice(km, state.vehicle), minLegPrice(state.vehicle))`
  at each road's km, labelled "about". Their sum is only a guide, because booking re-prices
  through the engine. The engine answer decides only whether a cheaper fork exists and its
  km/min. If the plan's own prices for the two roads are equal, show no chip for that drive.
- **Chip.** `distHtml` gets a third argument, `key`. When `roadOptions.has(key)` it appends a
  `<button type="button" class="lm-road" data-road-key="…">`:
  - With no choice yet: `Cheaper local road · save about $X`.
  - After a choice: `Road: Local road ▾` / `Road: Expressway ▾`.

  Its styles go in plan.html's inline `<style>`. A delegated click on `#rail` opens the popup for
  that key, with `source:'card'` for analytics. Update both `distHtml` call sites (`render` and
  `recompute`) and `refreshVehiclePricing`.
- **Popup content.** Title `Two roads to {to}`. Prices are `about $X` for the current vehicle, and
  there is no `extra`.
  - `onPick(v)` calls `roadChoice.set(key,v)`, then `render()`, `updateSummary()`, `syncPlanUrl()`
    and `renderMap()`, then `chTrack('route_choice',{choice:v,source,page:'plan',saving_usd})`.
  - `onDismiss` tracks `dismissed`.
- **Auto-open, `maybeOfferRoad()`.**
  - Candidates are drives in `state.legs` order that are in `roadOptions`, have no `roadChoice`,
    and are not `wasAsked`.
  - If there are none, it returns. If the page isn't quiet, it sets `pendingOffer=true` and
    returns. The page is quiet when `document.activeElement` is not an `input`, `textarea` or
    `select`, no `.place-menu` is in the DOM (check the real class with grep), and
    `!CH_ROUTE_CHOICE.isOpen()`, **and** the dates step is not showing
    (`document.getElementById('dates-wrap')?.hidden !== false`). `render()` fires from late
    live-route callbacks while that step is open.
  - A `focusout` listener on `document`, run after `setTimeout(0)`, calls `maybeOfferRoad()` when
    `pendingOffer` is set.
  - When it opens, it marks **every** current candidate as asked and opens only the first. It
    never chains.
- **Map.** `routeRuns(names, gapSet, roadAt)` splits stretches at gaps **and** where
  `roadAt(i)` changes. It sets `avoidTolls: roadAt(i)==='no_tolls'` and uses `continues:true`
  when a run starts where the previous kept run ended, following
  `api/src/quote/customerQuoteView.ts:198-222`. `renderMap` passes `runs` whenever there are gaps
  **or** any `no_tolls` drive. With neither, the options are unchanged: one single query, as today.
  - **`mapKey` must include the roads** (`plan.js:976`): `mapKey(names, gapSet, roads)`, where
    `roads` is the per-wire `no_tolls`/empty list. Without it, `renderMap` returns early at the
    unchanged-key guard (≈997), and a road pick never redraws the map. Add an e2e assertion that
    picking the local road triggers a second `computeRoutes` request carrying `avoidTolls`.
    `installStubs` records `__computeRoutesReqs`.
- **Hand-off.**
  - `goToBooking` adds `roads` when any wire is `no_tolls`: for wire `i`,
    `roadChoice.get(liveRouteKey(seq[i].place, seq[i+1].place))==='no_tolls' ? 'no_tolls' : ''`.
    Gap wires are always empty.
  - `syncPlanUrl` writes the same `roads`, or deletes it.
  - On load, `roads` from the URL seeds `roadChoice` for the wires of `startStops`.

Steps:

- [ ] **Step 1: Failing e2e** `web-tests/e2e/plan-route-choice.spec.js`.
  - Stub `**/quote/v2/estimate-batch` with `page.route`. For an intent whose leg is
    `Colombo Airport (CMB) → Ella`, return a `routeChoice` with 335/299 and 213/374. Return
    `{totalCents,currency}` with no `routeChoice` for any other leg. Count the requests.
  - Reuse the plan specs' way of starting a plan with stops. For example, open
    `plan.html?stops=Colombo Airport (CMB)|Ella|Yala&nights=0,1,0&pax=2`, checking an existing
    `plan-*.spec.js` for the exact param names.

  Tests:
  1. One batch request is sent carrying 2 intents. The CMB → Ella card shows
     `Cheaper local road · save about $`, and Ella → Yala shows no chip.
  2. The dialog auto-opens once, titled `Two roads to Ella`.
  3. Picking the local road:
     - the chip reads `Road: Local road ▾`;
     - that card's distance reads `213 km`;
     - the guide total drops;
     - the `route_choice` push has `page:'plan'`.
  4. Continuing to booking lands on a URL whose `roads` is `no_tolls,` and whose `kms` starts
     with `213`.
  5. With the plan text field focused when the batch lands, no dialog opens until focus leaves the
     field. Then it opens once.
  6. Changing the CMB → Ella drop-off to Kandy removes the chip, and `roads` leaves the URL.
  7. A reload does not reopen the dialog, and the chip and the choice persist through `roads`.
  8. `?api=off` sends no batch request and shows no chip.
- [ ] **Step 2: Run it red.**
- [ ] **Step 3: Implement** to the rules above.
- [ ] **Step 4: Stamp, run the spec green, then the full web gate.** All existing `plan-*.spec.js`
  must stay green, especially `plan-gapped-route-map.spec.js`, since `routeRuns` changed.
- [ ] **Step 5: Visual check from the e2e run**, as in Task 4 step 9. Screenshot the chip, the
  popup, and the card after the pick, look at each, and attach them to the PR.
- [ ] **Step 6: Commit** `plan.js plan.html web-tests/e2e/plan-route-choice.spec.js` and the
  restamped pages, with the message
  `feat(plan): offer the cheaper local road per drive (route choice 5/5)`. Open the PR with base
  `rc/4-search`.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| §4.1 leg `routeVariant`, `compareRoutes`, batch, cheaper-only, offline guard | 1 |
| §4.2 booking fields, 422 never-switch, columns, migration | 2 |
| §4.3 ops sheet, Paid: body not subject, confirmation email | 2 |
| §4.4 booking page parse, echo notice, summary, map, 422 handling | 3 |
| §4.5 shared popup, phone sheet, a11y, once, never stacks | 4 (component), 5 (reuse) |
| §4.6 search trigger rules, switch, fare-shown exception, savings, no double tracking | 4 |
| §4.7 plan batch, chip, auto-open when quiet, no chaining, edits re-arm, hand-off, map | 5 |
| §4.8 sightseeing unchanged (flat extra, stacks on either road) | 3 test 3 covers a single booking. The extra's pricing is untouched by design |
| §4.9 analytics `route_choice` + GTM regen | 4 |
| §4.10 chauffeur excluded with notice | 2 (400), 3 (drop + notice) |
| §6 gates | every task |

**Not built, by design:** the Google-picked plan drives (the batch prices catalogue towns only),
`manage.html`, and the `/trip/*` pages (spec §9).

## Revision log

**2026-09-27, after an independent critique against the code.** All 15 findings were checked and
applied:

1. The shared estimate stub passes `routeChoice` through (Task 4).
2. Every plan e2e spec blocks the batch endpoint, so no live prod calls or Google billing happen
   in tests (Task 5).
3. `mapKey` includes the roads, so a pick redraws the map (Task 5).
4. `cheaperRouteChoice` reuses the measured distance, so there's no second distance lookup
   (Task 1).
5. `/v2/lock` and `PUT /v2/:id` refuse a road (Task 1).
6. Trip enrichment measures the priced road (Task 2).
7. The fake maps can't make a cheaper fork, so visual checks come from Playwright screenshots
   (Tasks 4 and 5).
8. The server caps comparisons at 12 per batch, and the client caps drives at 10 (Tasks 1 and 5).
9. The 422 response shows no one-click retry (Task 3).
10. The echo is adopted under the new signature (Task 3).
11. The catalogue branch sets roads only after its `settled` guard, and the expressway km stays
    the catalogue's (Task 4).
12. The PR bodies flag `pricing.ts`, `route-choice.js`, `_stubs.js`, the reach of `factRows`, and
    the copy change.
13. The plan popup stays shut on the dates step (Task 5).
14. `tripEditUrl` is rebuilt when roads clear (Task 3).
15. Imports go at the top of the test file. The `null` versus `'fastest'` difference from the
    spec is noted.

**A re-review of those fixes found 8 more issues, all applied:**

- **Batch endpoint.** The 404 for the batch endpoint now also covers `gotoBooking` and
  `live-pricing.spec.js`, and the order of route stubs is fixed.
- **Echo signature.** The echo now uses one fresh signature for every use, including the parked
  price raise.
- **False claim removed.** The plan no longer claims the echo saves a second estimate request.
- **Lock and update checks.** The per-handler `carriesRoad` calls now compile, and the PUT test
  sends the real auth header.
- **Comparison slots.** A batch slot is claimed only after the catalogue check.
- **Expressway price and distance.** The saved expressway price is captured after the engine
  quote. The popup's expressway distance comes from that saved quote.
- **Buttons.** The Edit and Back buttons build their URL at click time.
- **Map requests.** The new plan spec installs the map stubs, so map requests are recorded.
