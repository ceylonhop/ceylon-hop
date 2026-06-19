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
3. **Backend lives in `api/` only.** NEVER edit the frozen front-end / live site (root
   `*.html`, `site.css`, `favicon.svg`, `image-slots.state.json`, and the front-end
   `*.js`: booking, datepicker, image-slot, plan, routes-data, search, site, tours-data,
   transfers-data, tweaks). A PreToolUse hook blocks this — don't fight it.
4. **No real external services.** PayHere / Google / email are reached only through an
   adapter with a fake. Real swaps are their own labelled steps.
5. **Keep interfaces stable** once defined; changing one is its own step.
6. **Leave it green.** `cd api && npm run check` (and `npm run smoke` from M6) must pass
   before opening a PR.
7. **Stop and ask** if a step is ambiguous, needs an out-of-scope / interface / dependency
   change, needs a new external service, or fails twice. Do not improvise.

## Stack (do not substitute)
Node 20 · TypeScript (strict) · Hono · Zod · Vitest · Drizzle + Postgres (Supabase) · npm.
API in `api/`. Money = integer minor units + ISO currency. IDs = uuid.

## Commands
```
cd api && npm run check    # typecheck + lint + test — the PR gate
cd api && npm test
cd api && npm run dev      # http://localhost:8787
```
