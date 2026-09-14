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

## Task 4: Bookings hold, count and re-hold a code

Implementation follows the plan as written. `tsc` exits 0; the only `BookingRepo` implementers are
`InMemoryBookingRepo` and `PostgresBookingRepo`, so the widened interface broke nothing else.

**Deviation (test fixture only).** The first Postgres-backed gate failed *"counts a succeeded
payment even before the status catches up (manual mark-paid)"* with
`duplicate key value violates unique constraint "payments_provider_gateway_payment_id_unique"`
(`Key (provider, gateway_payment_id)=(fake, bank-123) already exists`). The plan's fixture passed a
fixed manual reference `'bank-123'`; `payments` has `UNIQUE (provider, gateway_payment_id)`, so
the case fails on any second run against the same database. It passed on the first local run and
would pass on CI's fresh database, but it is not re-runnable. Fix: the reference is now
`bank-<random>`. No production code or behaviour changed.

**Postgres:** ran locally against `ceylonhop_test`. The Postgres contract (every §5.1 counting
case, every §6.3 re-hold case, and the 10-concurrent-bookings-for-3-uses "never oversells" case)
passed, as did `bookings.test.ts` and `checkout.test.ts`. The red run below is the in-memory
contract before the implementation (`bookings.attachPayments is not a function`).

**Red** (`npx vitest run src/db/bookingPromo.test.ts`):

```
TypeError: bookings.attachPayments is not a function
 ❯ src/db/bookingPromo.test.ts:185:12
    183|   const bookings = new InMemoryBookingRepo();
    184|   const payments = new InMemoryPaymentRepo();
    185|   bookings.attachPayments(payments);
       |            ^
    186|   return { bookings, payments, promoCodes: new InMemoryPromoCodeRepo()…
    187| });
 ❯ setup src/db/bookingPromo.test.ts:43:25
 ❯ src/db/bookingPromo.test.ts:169:41
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[13/13]⎯
 Test Files  1 failed (1)
      Tests  13 failed | 5 passed (18)
   Start at  17:54:34
   Duration  185ms (transform 52ms, setup 0ms, import 76ms, tests 9ms, environment 0ms)
```

**Green** (`DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npm run check (after the fixture fix)`):

```
> eslint .
/Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api/src/routes/opsUi.test.ts
  413:5  warning  Unused eslint-disable directive (no problems were reported from 'no-new-func')
✖ 1 problem (0 errors, 1 warning)
  0 errors and 1 warning potentially fixable with the `--fix` option.
> ceylon-hop-api@0.0.0 test
> vitest run
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  169 passed (169)
      Tests  2675 passed | 1 expected fail (2676)
   Start at  17:58:07
   Duration  10.70s (transform 5.89s, setup 0ms, import 38.77s, tests 12.83s, environment 10ms)
```

**Gate** (`cd api && npm run check`, exit 0):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  166 passed | 3 skipped (169)
      Tests  2598 passed | 1 expected fail | 77 skipped (2676)
   Start at  17:58:26
   Duration  10.16s (transform 5.37s, setup 0ms, import 38.99s, tests 8.50s, environment 12ms)
```

## Task 5: Booking routes accept a code; checkout re-checks the hold

Implementation follows the plan as written, with one carry-over from Task 3: the plan's Step 5
(`server.ts` wiring `promoCodes: new PostgresPromoCodeRepo(db)`) and the `AppDeps.promoCodes` field
already landed in Task 3, so this task adds only `promoCodesEnabled` and `promoNow` to `AppDeps`,
switches the `promoCodeRepo` import from type-only to a value import (for the in-memory default),
and wires the three deps into `bookingRoutes`. `tsc` exits 0.

The plan's fixture precondition held: a 5 km car hop prices at exactly the $29.00 car minimum, so
the "limits reduce it to $0 → `promo_code_not_eligible`, no use taken" case is a real test.

Red run: 14 of 15 fail (the code is ignored, so totals are undiscounted and no error is raised).
The one that already passed is "honours a valid hold even though the code has expired since",
which only asserts a 200 from checkout and so holds vacuously before the feature exists; the
other checkout cases pin the hold and the 409s.

**Red** (`npx vitest run src/routes/promoCodeBookings.test.ts`):

```
+ Received
- 7020
+ 7800
 ❯ src/routes/promoCodeBookings.test.ts:214:39
    212|     const res = await w.checkout(w.make(false), b);
    213|     expect(res.status).toBe(200);
    214|     expect((await res.json()).amount).toBe(7020);
       |                                       ^
    215|   });
    216| });
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[14/14]⎯
 Test Files  1 failed (1)
      Tests  14 failed | 1 passed (15)
   Start at  17:59:47
   Duration  850ms (transform 374ms, setup 0ms, import 696ms, tests 65ms, environment 0ms)
```

**Green** (`npx vitest run src/routes/promoCodeBookings.test.ts src/routes/bookings.test.ts src/routes/checkout.test.ts src/routes/discountReachesBooking.test.ts`):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  4 passed (4)
      Tests  68 passed (68)
   Start at  18:01:17
   Duration  1.05s (transform 1.67s, setup 0ms, import 3.38s, tests 264ms, environment 0ms)
```

**Gate** (`cd api && npm run check`, exit 0):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  167 passed | 3 skipped (170)
      Tests  2613 passed | 1 expected fail | 77 skipped (2691)
   Start at  18:01:40
   Duration  10.33s (transform 5.75s, setup 0ms, import 40.97s, tests 8.71s, environment 10ms)
```

## Task 6: Estimate previews a code

Implementation follows the plan as written (`quote.ts` deps, `previewPromo`, the `/v2/estimate`
handler, and the `quoteRoutes` mount in `app.ts`). Red run: 3 of 5 fail — the strict intent
schema answers **400** for the `promoCode` field, as the plan predicted; "adds nothing when no code
is sent" and "still rejects any other unknown field" already pass, as they should.

**Deviation (test fixture only).** After implementing, "previews the discount next to the
unchanged price" still failed: the preview answered `{ error: 'promo_code_not_eligible' }`
instead of a discount. Cause: the plan's fixture, Kandy → Nanu Oya on the fake maps adapter,
prices at **exactly $29.00, the car minimum** (`totalBeforeDiscountCents: 2900`), so the vehicle
floor leaves no headroom and a 10% code resolves to $0 — which is precisely the spec's
owner-approved §4.3 row 3 ("$29.00 at 10% → `promo_code_not_eligible`"). The implementation was
right; changing it to make the test pass would have broken the spec. Fix: the fixture now uses
Kandy → Ella (`routeId` is identity only and does not feed pricing), and the test asserts a
precondition that the undiscounted price is above the level where the floor could bind, so a
future fixture change fails loudly rather than misleadingly. The red evidence below predates the
fixture change; its failure (the 400 from the strict schema) does not depend on the route.

**Red** (`npx vitest run src/routes/promoCodeEstimate.test.ts`):

```
}
+ Received:
undefined
 ❯ src/routes/promoCodeEstimate.test.ts:81:93
     79|
     80|     await w.bookings.create(booking, { promo: { code, now: NOW } });
     81|     expect((await (await w.send({ ...V2_PRIVATE, promoCode: 'SAVE10' }…
       |                                                                                             ^
     82|   });
     83|
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯
 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
   Start at  18:02:47
   Duration  237ms (transform 97ms, setup 0ms, import 138ms, tests 23ms, environment 0ms)
```

**Green** (`npx vitest run src/routes/promoCodeEstimate.test.ts src/routes/quote.test.ts`):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  2 passed (2)
      Tests  40 passed (40)
   Start at  18:05:11
   Duration  789ms (transform 463ms, setup 0ms, import 822ms, tests 80ms, environment 0ms)
```

**Gate** (`cd api && npm run check`, exit 0):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  168 passed | 3 skipped (171)
      Tests  2618 passed | 1 expected fail | 77 skipped (2696)
   Start at  18:05:21
   Duration  10.63s (transform 5.99s, setup 0ms, import 41.81s, tests 8.71s, environment 12ms)
```

## Task 7: Founder API for managing codes

Plan followed as written; no deviations. The capability `promo_codes:manage` is added to the
`OpsAction` union and the founder set only; `ops.roles.test.ts` and `opsUi.test.ts` derive their
expectations from the matrix and pass unchanged. The routes are mounted before
`/admin/quote`, with their own rate limiter.

Red run: 7 of 8 fail with **404** (no route mounted). The one that already passed is "answers 404
for an unknown or malformed id", which holds vacuously before the router exists.

**Postgres:** the Postgres-backed gate also exited 0 (172 files passed, 2703 tests passed,
1 expected fail).

**Red** (`npx vitest run src/routes/promoCodes.test.ts`):

```
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/7]⎯
 FAIL  src/routes/promoCodes.test.ts > /admin/promo-codes > with the flag off: creating is refused, switching a code off still works
SyntaxError: Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)
 ❯ src/routes/promoCodes.test.ts:107:21
    105|   it('with the flag off: creating is refused, switching a code off sti…
    106|     const on = world();
    107|     const created = await (await on.call('POST', '', NEW)).json();
       |                     ^
    108|     const offApp = createApp({ auth: AUTH, adminApiKey: 'k', bookingLi…
    109|     const req = (method: string, path: string, body: unknown) => offAp…
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/7]⎯
 Test Files  1 failed (1)
      Tests  7 failed | 1 passed (8)
   Start at  18:06:45
   Duration  738ms (transform 364ms, setup 0ms, import 630ms, tests 26ms, environment 0ms)
```

**Green** (`npx vitest run src/routes/promoCodes.test.ts src/routes/ops.roles.test.ts src/routes/opsUi.test.ts`):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  3 passed (3)
      Tests  155 passed (155)
   Start at  18:07:46
   Duration  1.28s (transform 1.27s, setup 0ms, import 2.40s, tests 466ms, environment 0ms)
```

**Gate** (`cd api && npm run check`, exit 0):

```
 RUN  v4.1.9 /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/agent-a68aff99abec92738/api
 Test Files  169 passed | 3 skipped (172)
      Tests  2626 passed | 1 expected fail | 77 skipped (2704)
   Start at  18:07:56
   Duration  10.76s (transform 6.07s, setup 0ms, import 42.33s, tests 8.88s, environment 12ms)
```

## Task 8: Full verification

- `cd api && npm run check`: exit 0 after Task 7 (169 files passed, 3 skipped; 2626 tests passed,
  1 expected fail, 77 skipped). The Postgres suites were skipped in that plain run.
- Postgres-backed suites: ran locally against `postgres://localhost:5432/ceylonhop_test` during
  Tasks 3, 4 and 7. Migration 0050 applied cleanly from 0049, the `PostgresPromoCodeRepo` and
  booking-promo contracts passed (including the concurrent last-use test), and `rlsEnabled.test.ts`
  passed. The last Postgres-backed gate after Task 7 exited 0 (172 files, 2703 tests passed).
- `web-tests` `npm run test:all` (vitest, then Playwright): passed. Playwright `.last-run.json`
  reads `{"status":"passed","failedTests":[]}` (run ended 18:12:49 local time).
- Runtime caveat: everything above ran on Node v22.17.1 locally; CI runs Node 20 and is the
  authority for that version.

## Task 8: Full verification

- **`cd api && npm run check`** on the final code (after Task 7): exit 0 — 169 files passed,
  3 skipped; 2626 tests passed, 1 expected fail, 77 skipped. With
  `DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test`: exit 0 — 172 files passed,
  2703 tests passed, 1 expected fail.
- **Postgres suites** (`DATABASE_URL_TEST=postgres://localhost:5432/ceylonhop_test npx vitest run
  src/db/postgres.test.ts src/db/rlsEnabled.test.ts`): exit 0 — 2 files, 98 tests passed. These ran
  locally against Postgres 16; CI runs them again on the PR.
- **web-tests** (`cd web-tests && npm ci && npm run test:all`): exit 0. Vitest: 90 files, 1258
  tests passed. Playwright (Chromium, already cached locally, so nothing was downloaded): 582
  passed, 33 skipped, 0 failed (3.4 min). No front-end file changed on this branch.
- Local Node was v22.17.1 throughout (see Environment); CI pins Node 20.
