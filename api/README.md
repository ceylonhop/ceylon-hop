# Ceylon Hop API

Backend for the Ceylon Hop booking system. Built step-by-step per
[`../docs/build-plan.md`](../docs/build-plan.md).

## Run

```bash
npm install
npm run dev      # http://localhost:8787  (GET /health → {"status":"ok"})
npm test         # run tests once
npm run check    # typecheck + lint + test  — the gate for every PR
```

Stack: Node 20 · TypeScript (strict) · Hono · Vitest. Postgres (Supabase) via Drizzle and
Zod validation arrive in later milestones.
