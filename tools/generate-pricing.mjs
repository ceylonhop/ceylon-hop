// Generates the front-end pricing constants from the backend rate card, so no price is
// ever hand-typed in the front-end. Reads the canonical payload from the api dump
// (api/scripts/dump-pricing.ts), injects a fenced block into transfers-data.js, and
// (Task 5) rewrites the shared-ride prices in routes-data.js. Dependency-free ESM, matching
// the other tools/*.mjs generators. Run via `npm run generate` (or generate:pricing).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PRICING_BEGIN =
  '/* @generated:pricing — from api/src/quote/rateCard.ts · DO NOT EDIT BY HAND · run `npm run generate` */';
export const PRICING_END = '/* @end:pricing */';

const j = (o) => JSON.stringify(o);

// The exact text of the generated block (without surrounding indentation — injectPricingBlock
// re-indents each line to match wherever the BEGIN sentinel sits).
export function renderPricingBlock(p) {
  return [
    PRICING_BEGIN,
    `const PER_KM = ${j(p.perKm)};`,
    `const FLOORS = ${j(p.floors)};`,
    `const BUFFER_PCT = ${p.bufferPct};`,
    `const CHAUFFEUR_DAY_FEE = ${p.chauffeurDayFee};`,
    `const DEPOSIT_PCT = ${p.depositPct};`,
    `const DEPOSIT_CAP = ${p.depositCap};`,
    `const EXTRAS = ${j(p.extras)};`,
    `const CORRIDOR_SEAT = ${j(p.corridorSeat)};`,
    PRICING_END,
  ].join('\n');
}

// Replace everything between the sentinels (inclusive) with a freshly rendered block,
// preserving the indentation of the BEGIN sentinel line. Idempotent.
export function injectPricingBlock(src, payload) {
  const b = src.indexOf(PRICING_BEGIN);
  const e = src.indexOf(PRICING_END);
  if (b === -1 || e === -1) throw new Error('pricing sentinels not found in source');
  const indent = src.slice(src.lastIndexOf('\n', b) + 1, b); // leading whitespace before BEGIN
  const block = renderPricingBlock(payload)
    .split('\n')
    .join('\n' + indent);
  return src.slice(0, b) + block + src.slice(e + PRICING_END.length);
}

// Run the backend dump and parse the canonical payload.
export function readPayload() {
  const out = execFileSync('npm', ['run', '--silent', 'dump:pricing'], {
    cwd: join(ROOT, 'api'),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

// Evaluate a browser IIFE (transfers-data.js / routes-data.js) in a window shim and read
// back the global it assigns — same trick as tools/load-transfers.mjs.
function evalWindow(src, prop, filename) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename });
  const val = sandbox.window[prop];
  if (!val) throw new Error(`${filename} did not define window.${prop}`);
  return val;
}

// Replace only the FIRST `price:<n>` that appears after the route's `id:'<id>'` — i.e. that
// route object's own price — leaving every other route (including packages) untouched.
function replaceRoutePrice(src, id, seat) {
  const idRe = new RegExp(`id:\\s*'${id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}'`);
  const m = idRe.exec(src);
  if (!m) throw new Error(`route id '${id}' not found in routes-data.js`);
  const priceRe = /price:\s*\d+/;
  const after = src.slice(m.index);
  const pm = priceRe.exec(after);
  if (!pm) throw new Error(`no price field after shared route '${id}'`);
  const start = m.index + pm.index;
  return src.slice(0, start) + `price:${seat}` + src.slice(start + pm[0].length);
}

// Rewrite the `price` of every `type:'shared'` route to its corridor's flat seat price,
// resolved through the engine's own sharedOption (the authoritative stop->corridor mapping).
export function applySharedPrices(routesSrc, transfers) {
  const ROUTES = evalWindow(routesSrc, 'ROUTES', 'routes-data.js');
  let out = routesSrc;
  for (const r of ROUTES) {
    if (r.type !== 'shared') continue;
    const fromId = transfers.resolvePlace(r.stops[0])?.id;
    const toId = transfers.resolvePlace(r.stops[1])?.id;
    const opt = fromId && toId ? transfers.sharedOption(fromId, toId) : null;
    if (!opt) throw new Error(`no corridor carries shared route ${r.id} (${r.stops[0]} -> ${r.stops[1]})`);
    out = replaceRoutePrice(out, r.id, opt.seat);
  }
  return out;
}

// Full generation: inject the pricing block into transfers-data.js, then rewrite the shared
// prices in routes-data.js off the freshly-generated corridor seats.
export function main() {
  const payload = readPayload();
  const tPath = join(ROOT, 'transfers-data.js');
  const tSrc = injectPricingBlock(readFileSync(tPath, 'utf8'), payload);
  writeFileSync(tPath, tSrc);
  const transfers = evalWindow(tSrc, 'TRANSFERS', 'transfers-data.js');
  const rPath = join(ROOT, 'routes-data.js');
  writeFileSync(rPath, applySharedPrices(readFileSync(rPath, 'utf8'), transfers));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
