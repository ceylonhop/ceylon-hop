# Promo codes backend — red→green evidence

One section per task: the failing run, then the passing run (last ~15 lines of each).

## Environment

- Node: **v22.17.1** locally. Node 20 is not installed on this machine (no nvm/fnm/volta, no
  Homebrew `node@20`), and installing one would mean downloading a runtime, which this unattended
  run avoids. `api/package.json` pins `engines.node` to `20.x`; `npm ci` succeeded under 22 with an
  engine warning only. CI (`ci.yml`) runs Node 20 and is the authority on that version.
- Baseline before any change (`cd api && npm run check`, no `DATABASE_URL_TEST`): exit 0 —
  163 files passed, 3 skipped; 2535 tests passed, 1 expected fail, 59 skipped.
- Postgres: a local Postgres 16 with a `ceylonhop_test` database (migrated to 0049) is available at
  `postgres://localhost:5432/ceylonhop_test`. Postgres-backed runs below say explicitly when they
  used it.

## Task 1: Promo code domain rules

Plan followed as written; no deviations. `npm run typecheck` also exits 0 after the change
(proves `source: 'code'` is accepted by `DiscountRequest`). The single lint warning in every gate
run (`Unused eslint-disable directive … no-new-func`) is pre-existing; the baseline had it.

**Red** (`npx vitest run src/domain/promoCode.test.ts`):

```
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/domain/promoCode.test.ts [ src/domain/promoCode.test.ts ]
Error: Cannot find module './promoCode' imported from /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api/src/domain/promoCode.test.ts
 ❯ src/domain/promoCode.test.ts:3:1
      1| // Promo code domain rules (spec docs/superpowers/specs/2026-09-14-pro…
      2| import { describe, it, expect } from 'vitest';
      3| import {
       | ^
      4|   normalizePromoCode,
      5|   promoCodeAvailability,
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
 Test Files  1 failed (1)
      Tests  no tests
   Start at  17:46:09
   Duration  109ms (transform 17ms, setup 0ms, import 0ms, tests 0ms, environment 0ms)
```

**Green** (`npx vitest run src/domain/promoCode.test.ts`):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  1 passed (1)
      Tests  18 passed (18)
   Start at  17:46:40
   Duration  138ms (transform 32ms, setup 0ms, import 50ms, tests 7ms, environment 0ms)
```

**Gate** (`cd api && npm run check`, exit 0):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  164 passed | 3 skipped (167)
      Tests  2553 passed | 1 expected fail | 59 skipped (2613)
   Start at  17:46:56
   Duration  9.98s (transform 5.53s, setup 0ms, import 39.10s, tests 8.49s, environment 10ms)
```

## Task 2: Pricing accepts a code discount

Plan followed as written; no deviations. The red run fails the two tests that read the new
fields (single and trip: `expected undefined to be 780`); the "no discount fields" and "unpriced"
tests already pass before the change, as they should. The green run is the whole
`pricing.test.ts` (all 28 existing + new tests).

**Red** (`npx vitest run src/services/pricing.test.ts -t "promo code discount"`):

```
780
+ Received:
undefined
 ❯ src/services/pricing.test.ts:237:31
    235|     const off = await priceTrip(t, maps, RATE_CARD, tenPercent);
    236|     if (!plain.priced || !off.priced) throw new Error('expected both t…
    237|     expect(off.discountCents).toBe(Math.floor((plain.totalCents * 1000…
       |                               ^
    238|     expect(off.totalCents).toBe(plain.totalCents - off.discountCents!);
    239|   });
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯
 Test Files  1 failed (1)
      Tests  2 failed | 2 passed | 24 skipped (28)
   Start at  17:48:18
   Duration  187ms (transform 78ms, setup 0ms, import 98ms, tests 6ms, environment 0ms)
```

**Green** (`npx vitest run src/services/pricing.test.ts`):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  1 passed (1)
      Tests  28 passed (28)
   Start at  17:48:52
   Duration  201ms (transform 81ms, setup 0ms, import 104ms, tests 9ms, environment 0ms)
```

**Gate** (`cd api && npm run check`, exit 0):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  164 passed | 3 skipped (167)
      Tests  2557 passed | 1 expected fail | 59 skipped (2617)
   Start at  17:49:01
   Duration  10.39s (transform 5.97s, setup 0ms, import 41.44s, tests 8.46s, environment 22ms)
```

## Task 3: promo_codes table and code storage

**Deviation (wiring moved forward from Task 5).** The first gate run failed an existing guard,
`src/serverWiring.test.ts`: *"not constructed in server.ts: PostgresPromoCodeRepo"*. That test
requires every `Postgres*Repo` under `src/db` to be constructed in `server.ts` as soon as it
exists, while the plan only wires it in Task 5. Smallest fix, no behaviour change: this task
also adds `promoCodes?: PromoCodeRepo` to `AppDeps` (type import only) and the plan's Task 5
`server.ts` line `promoCodes: new PostgresPromoCodeRepo(db)`. `app.ts` does not read the dep
until Task 5, so nothing routes through it yet. Task 5 therefore skips its Step 5 (already done)
and only adds the rest of the `AppDeps` fields.

**Postgres:** ran locally against `postgres://localhost:5432/ceylonhop_test`. Migration 0050
applied from the database's prior 0049 state, the `PostgresPromoCodeRepo` contract passed, and
`rlsEnabled.test.ts` passed (so `promo_codes` has RLS on). The gate was run twice: plain
`npm run check` (Postgres suites skipped, as in CI-less dev) and with `DATABASE_URL_TEST` set.
The Postgres-backed gate also exited 0: 168 files passed, 2631 tests passed, 1 expected fail.
The green run below is the Postgres-backed run of the three files the plan names.

**Red** (`npx vitest run src/db/promoCodeRepo.test.ts`):

```
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/db/promoCodeRepo.test.ts [ src/db/promoCodeRepo.test.ts ]
Error: Cannot find module './promoCodeRepo' imported from /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api/src/db/promoCodeRepo.test.ts
 ❯ src/db/promoCodeRepo.test.ts:5:1
      3| import { describe, it, expect } from 'vitest';
      4| import { randomUUID } from 'node:crypto';
      5| import {
       | ^
      6|   InMemoryPromoCodeRepo,
      7|   PromoCodeTakenError,
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
 Test Files  1 failed (1)
      Tests  no tests
   Start at  17:49:58
   Duration  113ms (transform 19ms, setup 0ms, import 0ms, tests 0ms, environment 0ms)
```

**Green** (`DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npx vitest run src/db/promoCodeRepo.test.ts src/db/postgres.test.ts src/db/rlsEnabled.test.ts`):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  3 passed (3)
      Tests  77 passed (77)
   Start at  17:51:22
   Duration  1.68s (transform 274ms, setup 0ms, import 952ms, tests 1.17s, environment 0ms)
```

**Gate** (`cd api && npm run check`, exit 0):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  165 passed | 3 skipped (168)
      Tests  2567 passed | 1 expected fail | 64 skipped (2632)
   Start at  17:52:50
   Duration  10.57s (transform 6.33s, setup 0ms, import 41.51s, tests 8.94s, environment 11ms)
```
