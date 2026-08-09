// api/src/serverWiring.test.ts
// Every Postgres repository must actually be handed to createApp() in server.ts.
//
// This exists because of a real, silent production failure (2026-08-09). PostgresQuoteDiscountRepo
// was written, tested against a real database, and then never wired in server.ts. app.ts falls
// back to an in-memory repo when a dep is absent, so nothing crashed and no test failed — but
// PostgresQuoteRepo.update still wrote the discount row inside the save transaction, so the data
// really was in Postgres while every READ went to an empty object in memory.
//
// The symptom was a quote that priced correctly on save and showed undiscounted on the next load.
// It took the owner testing on staging to find it, because every unit test passed a repo in
// explicitly and therefore never exercised the fallback.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_DIR = join(import.meta.dirname, 'db');
const SERVER = join(import.meta.dirname, 'server.ts');

/**
 * Repos that are deliberately NOT constructed in server.ts. Each needs a reason — an empty
 * allowance here is how the next one slips through.
 */
const NOT_IN_SERVER: Record<string, string> = {
  // Constructed inside PostgresPaymentSettlementRepo / passed a bookings repo, not a db handle.
  PostgresPaymentEventRepo: 'composed inside the settlement repo, not at the top level',
};

function exportedPostgresRepos(): string[] {
  return readdirSync(DB_DIR)
    .filter((f) => /^postgres.*\.ts$/i.test(f) && !f.endsWith('.test.ts'))
    .flatMap((f) => {
      const src = readFileSync(join(DB_DIR, f), 'utf8');
      return [...src.matchAll(/export class (Postgres\w+)/g)].map((m) => m[1]);
    });
}

describe('server.ts wires every Postgres repository', () => {
  it('constructs each one, so no dep silently falls back to in-memory', () => {
    const server = readFileSync(SERVER, 'utf8');
    const missing = exportedPostgresRepos()
      .filter((name) => !(name in NOT_IN_SERVER))
      .filter((name) => !server.includes(`new ${name}(`));

    // A miss here does not crash anything — it quietly swaps a durable store for a per-process
    // one. Name the repo so the fix is obvious.
    expect(missing, `not constructed in server.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the discount repo wired specifically, since its absence is invisible', () => {
    const server = readFileSync(SERVER, 'utf8');
    expect(server).toContain('new PostgresQuoteDiscountRepo(db)');
    expect(server).toContain('quoteDiscounts:');
  });
});
