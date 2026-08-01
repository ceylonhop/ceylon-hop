# Promote to production — checklist

The steps to run **before and after** merging a `main → production` PR, and why each one exists.
Every item here is on the list because it either bit us, or is the kind of thing that fails
silently and expensively.

**Read this first:** a promote is a **whole-branch merge**. It carries *every* commit on `main` —
there is no cherry-picking. So the real gate is what gets merged to `main`; by the time you are
promoting, the decision has already been made. If something on `main` is not ready to ship,
it must come off `main`, not be skipped at promote time.

Related: [go-live-checklist.md](go-live-checklist.md) (the one-time cutover to real money),
[known-bugs.md](known-bugs.md), [staging-environment-plan.md](staging-environment-plan.md).

---

## 1. Before you open the promote PR

- [ ] **`main` is green.** `cd api && npm run check` (typecheck + lint + tests) and
      `cd web-tests && npm run test:all`.
      Note that **CI runs no Playwright specs at all** — the three required checks are api tests,
      web-tests *unit*, and codegen parity. A green PR badge does **not** mean the e2e suite passed.
      If the change touches the ops builder or the customer pages, run the e2e suite locally.
- [ ] **The `CH_E2E_API` suite too, if you touched quotes or bookings.**
      `DATABASE_URL_TEST=… CH_E2E_API=1 npx playwright test quote-tool` — it is skipped by default
      *and* by CI, so it rots unnoticed. On 2026-07-31 it had been 5-red on `main` with nobody aware.

## 2. The pre-flight that matters most — migrations

- [ ] **Count the migrations landing on the production database:**

      ```bash
      git fetch origin
      git diff --name-only origin/production..origin/main -- api/drizzle | grep -E '\.sql$'
      ```

      **Zero is the easy case.** Anything else means schema change on prod Supabase, applied
      automatically on boot (fail-closed) — merging the migration *is* releasing it. There is no
      separate "run migrations" step to reconsider at.
- [ ] **If there are migrations,** run the read-only money-constraint preflight against production
      first: `cd api && npm run db:preflight:money`. Every count must be zero.
- [ ] **Check for schema use without a migration.** A repo change can reference a column that no
      migration creates — green locally, broken on prod. Diff `api/src/db/` alongside `api/drizzle/`
      and confirm any new column already exists in the deployed schema.

## 3. Prove the promote is non-destructive to real data

The team runs real quotes through `/ops` while the public site is dark. That data has no other
home, so a promote must be provably non-destructive.

- [ ] **Take a census BEFORE:**

      ```bash
      cd api && DATABASE_URL="<prod>" npx tsx scripts/promote-audit.ts > ~/prod-before.json
      ```

      It is read-only. Keep the file.
- [ ] **Take the same census AFTER** the deploy and diff it. "Nothing was lost or silently
      restated" should be a diff, not a hope.

## 4. Merge

- [ ] **Merge method: `--merge`, never squash.** Promotes keep each commit on `production`
      (see #215, #206, #203). Squashing would flatten the history the audit trail depends on.

      ```bash
      gh pr merge <n> --merge
      ```
- [ ] A **human** presses this. Claude will do the pre-flight and open the PR, but the production
      merge is deliberately not automated.
- [ ] **After a force-push or rebase, re-wait for CI.** `gh pr merge` refuses while
      `mergeStateStatus` is `BLOCKED`, and the rollup can still show the *pre-rebase* results for a
      few seconds. Poll until it reads `CLEAN`, not just until the checks look green.

## 5. After the deploy — confirm the service, not the branch

A merged branch is not a running service. Check the deployed thing.

- [ ] `curl -s https://<host>/health` → `{"status":"ok"}`
- [ ] **Pick a marker unique to this release and verify it live.** Not "the site loads" — something
      that could only be true if this deploy landed. Examples that worked:
      `/pay.html` returning 200 (it 404'd before the customer-pages change),
      or `grep hop-dot` in `/ticket.css` after the rail moved into the shared stylesheet.
- [ ] **Re-run the promote audit** and diff against `~/prod-before.json`.
- [ ] If the release touched payments, confirm the webhook still answers:
      `curl -s -o /dev/null -w '%{http_code}' -X POST -d '' https://<host>/webhooks/payments`
      → **401** (exists, rejects unsigned). A **404** means the route moved and PayHere has
      nowhere to report a payment — money taken, booking stuck at `payment_pending`, no error.

## 6. Environment variables are NOT promoted

Code ships; config does not. A variable the new code reads has to exist on the Render service
**before** the code that reads it arrives, or the feature silently does nothing.

- [ ] **New env var in this release?** Set it on the service first, then promote.
- [ ] **Remember the reverse trap:** setting a variable whose supporting code is not yet deployed
      also does nothing. On 2026-07-31 `PAY_BASE_URL` sat set-but-ignored on `ceylon-hop-api` until
      a second promote shipped the code that read it — links kept pointing at the old host and
      nothing indicated a problem.
- [ ] **Do not disable the Render `onrender.com` subdomain** while `PAYHERE_NOTIFY_URL` points at
      it. Same silent-money failure as a moved webhook route.

## 7. Rolling back

There is no "unpromote". `production` is a branch and the deploy follows it, so recovery is
forward: fix on `main`, promote again. **A migration cannot be rolled back this way** — which is
why §2 is the item to slow down on.
