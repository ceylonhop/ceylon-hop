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
