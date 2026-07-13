# Ceylon Hop — agent operating contract

You are building the Ceylon Hop backend. Read these before acting:
- `docs/backend-spec.md` — the WHY (architecture, data model, decisions)
- `docs/build-plan.md` — the WHAT/HOW (tiny tested steps; **this is the execution order**)
- `docs/agent-team.md` — how we work (roles, gates, resilience)

## Hard rules (non-negotiable)
1. **One step = one branch = one PR.** Build ONLY what the step's "Build" list says. No
   scope creep, no extra "improvements".
2. **Tests required, proven.** Write the test, run it to see it FAIL, then implement until
   green. Paste the red→green evidence in the PR.
3. **Backend lives in `api/`.** Keep new backend code in `api/`. The front-end freeze was
   **lifted 2026-07-05** (owner decision — testing/UX-tweak phase): the root `*.html`,
   `site.css`, `favicon.svg`, and the front-end `*.js` (booking, datepicker, image-slot,
   plan, routes-data, search, site, tours-data, transfers-data, tweaks) are now editable.
   Still keep front-end changes scoped and covered by `web-tests/` (run `npm run test:all`),
   and remember `routes-data.js`/`transfers-data.js` prices mirror the backend rate card.
4. **No real external services.** PayHere / Google / email are reached only through an
   adapter with a fake. Real swaps are their own labelled steps.
5. **Keep interfaces stable** once defined; changing one is its own step.
6. **Leave it green.** `cd api && npm run check` (and `npm run smoke` from M6) must pass
   before opening a PR.
7. **Stop and ask** if a step is ambiguous, needs an out-of-scope / interface / dependency
   change, needs a new external service, or fails twice. Do not improvise.

## Maintenance mode — tweaks & bug-fixing (CURRENT PHASE, from 2026-07-13)

The build phase is largely done. We are now **tweaking and fixing bugs** on a codebase that is
close to launch (the new stack is **not yet the live customer site** — that is still WordPress —
but the ops/quoting tool is in internal use). Change management tightens accordingly. These
refine the Hard rules above for day-to-day changes:

1. **Propose before you change; wait for an explicit go.** Default for anything ambiguous or
   touching more than one file: say what you'll change and why, then wait.
   **Escape hatch:** when the owner names a clear, scoped fix ("just fix the label", "change X to
   Y"), do it directly — no propose-and-wait ceremony.
2. **One thing per request.** Fix exactly what's asked — no bundled extras, no "while I'm here"
   refactors, no opportunistic cleanup. Adjacent issues you notice → surface as a one-line note
   (or a task chip), do **not** fix them.
3. **Minimal footprint — STOP and ask first** before touching any of: **pricing**
   (`rateCard.ts` / `departureRepo.ts`), **DB schema / migrations**, **config** (`config.ts`,
   env), **generated files** (`@generated:` blocks; `terms`/`privacy`/`404`/`trip/*`), or a
   **shared component** used across pages. These carry blast radius beyond the change.
4. **Leave it green, always.** `cd api && npm run check` + `npm run test:all` (web-tests) pass
   before every commit. Never commit red.
5. **Prove bugs with a test.** For a logic/backend bug, write the failing test that reproduces it
   FIRST, then fix (red→green) — it proves the fix and leaves a regression guard. Not required
   for pure copy/CSS/visual tweaks — verify those in the browser preview instead.
6. **Keep changes reversible.** One logical change per commit, clear message. Multiple chats
   share one working tree on `main` — stage only your own files by path, never `git add -A`.
7. **No surprises to production.** `main` deploys to the live services (API on Render, site on
   Pages). Don't ship anything to prod — **especially schema/migrations, pricing, or config** —
   without the owner's explicit ok. Migrations are **NOT auto-applied** (this already caused a
   prod incident); if a change needs one, FLAG it and treat the prod migrate as a required,
   owner-run release step.

**Drift rules (always):** prices change ONLY via `rateCard.ts` (+ corridors in
`departureRepo.ts`) then `npm run generate` — never hand-edit a `@generated:` block (the parity +
codegen tests will, and should, fail). Generated pages change via their source + regenerate,
never by editing the output.

**Deferred (not now):** branch protection on `main`, a PR per change, CI-required-to-merge —
right-sized to add at the apex cutover or when human collaborators join, not before.

## Stack (do not substitute)
Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres (Supabase) · npm.
API in `api/`. Money = integer minor units + ISO currency. IDs = uuid.

## Commands
```
cd api && npm run check    # typecheck + lint + test — the PR gate
cd api && npm test
cd api && npm run dev      # http://localhost:8787
```
