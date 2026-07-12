# Ceylon Hop API

Backend for the Ceylon Hop booking system. Built step-by-step per
[`../docs/build-plan.md`](../docs/build-plan.md).

## Run

```bash
npm install
npm run dev      # http://localhost:8787  (GET /health → {"status":"ok"})
npm test         # run tests once
npm run check    # typecheck + lint + test  — the gate for every PR
npm run smoke    # end-to-end smoke against a running server
```

Stack: Node 20 · TypeScript (strict) · Hono · Zod · Drizzle + Postgres (Supabase) · Vitest.
All shipped and core to the service today.

Requires `DATABASE_URL` (Postgres) to boot the real server — set it in `api/.env`. Unit tests
run in-memory and need no DB (the DB-backed suite is gated on `DATABASE_URL_TEST`). Other
scripts: `db:generate` / `migrate` (Drizzle), `dump:pricing`, `demo`. The API also serves the
`/ops` founder dashboard and the `/quote` + `/admin/quote` quoting routes.
