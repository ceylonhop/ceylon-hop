// One-off baked-vs-live distance comparison + cache seeder (spec 2026-08-12 §Sequence step 2).
//
//   npx tsx scripts/distance-report.ts             # report only (needs GOOGLE_MAPS_API_KEY)
//   npx tsx scripts/distance-report.ts --seed      # also upsert into distance_cache (needs DATABASE_URL)
//   npx tsx scripts/distance-report.ts --seed --refresh   # re-fetch pairs that already have rows
//
// Bills one Distance Matrix element per uncached pair (~38 towns → ≤ ~1,400 elements worst
// case). NEVER run in CI. The report is the owner's review artifact: prices move where these
// deltas are non-zero, and that movement should be a decision, not a discovery.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { GoogleMapsAdapter, KNOWN_PLACES, canonPlace } from '../src/adapters/maps';
import { legPriceCents, billableKm } from '../src/quote/private';
import { finishPrice } from '../src/quote/priceFinish';
import { RATE_CARD } from '../src/quote/rateCard';
import { createDb } from '../src/db/client';
import { PostgresDistanceCacheRepo } from '../src/db/postgresDistanceCacheRepo';

const SEED = process.argv.includes('--seed');
const REFRESH = process.argv.includes('--refresh');

// The front-end's baked matrix, read the way tools/load-transfers.mjs reads it: evaluate the
// browser IIFE in a window shim. REAL_KM itself is module-private, so recover it through the
// exposed kmBetween/byId — same numbers, public surface.
function loadFrontEnd(): { kmBetween: (a: string, b: string) => number | null } {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(root, 'transfers-data.js'), 'utf8');
  const sandbox: { window: { TRANSFERS?: { kmBetween: (a: string, b: string) => number | null } } } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'transfers-data.js' });
  if (!sandbox.window.TRANSFERS) throw new Error('transfers-data.js did not define window.TRANSFERS');
  return sandbox.window.TRANSFERS;
}

function priceUsd(rawKm: number): number {
  const cents = legPriceCents(billableKm(rawKm), 'car');
  return finishPrice(cents, 0, RATE_CARD.priceFinishing).finalCents / 100;
}

async function main(): Promise<void> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is required — this script measures real routing');
  const maps = new GoogleMapsAdapter(key);
  const T = loadFrontEnd();

  const repo = SEED
    ? new PostgresDistanceCacheRepo(createDb(requireEnv('DATABASE_URL')).db)
    : null;

  const towns = KNOWN_PLACES;
  const rows: Array<{ pair: string; baked: number | null; live: number; dKm: number | null; dUsd: number | null; estimated: boolean }> = [];
  let billed = 0;
  let skipped = 0;

  for (const from of towns) {
    for (const to of towns) {
      if (from === to) continue;
      const fromKey = canonPlace(from);
      const toKey = canonPlace(to);

      let km: number;
      let durationMin: number;
      let estimated = false;
      const cached = repo && !REFRESH ? await repo.get(fromKey, toKey) : null;
      if (cached) {
        ({ km, durationMin } = cached);
        skipped++;
      } else {
        const live = await maps.distance(from, to);
        if (!live) continue;
        billed++;
        km = live.km;
        durationMin = live.durationMin;
        estimated = live.estimated === true;
        if (repo && !estimated) await repo.upsert({ fromKey, toKey, km, durationMin });
      }

      const baked = T.kmBetween(from, to);
      rows.push({
        pair: `${from} → ${to}`,
        baked,
        live: km,
        dKm: baked == null ? null : km - baked,
        dUsd: baked == null ? null : Math.round((priceUsd(km) - priceUsd(baked)) * 100) / 100,
        estimated,
      });
    }
  }

  rows.sort((a, b) => Math.abs(b.dUsd ?? 0) - Math.abs(a.dUsd ?? 0));
  console.log(`# Baked vs live distances — ${new Date().toISOString().slice(0, 10)}\n`);
  console.log(`${rows.length} pairs · ${billed} billed lookups · ${skipped} served from cache${SEED ? ' · seeded' : ''}\n`);
  console.log('| Pair | Baked km | Live km | Δ km | Δ price (car) | |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.pair} | ${r.baked ?? '—'} | ${r.live} | ${r.dKm ?? '—'} | ${r.dUsd == null ? '—' : `$${r.dUsd}`} | ${r.estimated ? '⚠ estimated, not seeded' : ''} |`,
    );
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required with --seed`);
  return v;
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
