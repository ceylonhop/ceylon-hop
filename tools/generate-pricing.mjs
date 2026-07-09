// Generates the front-end pricing constants from the backend rate card, so no price is
// ever hand-typed in the front-end. Reads the canonical payload from the api dump
// (api/scripts/dump-pricing.ts), injects a fenced block into transfers-data.js, and
// (Task 5) rewrites the shared-ride prices in routes-data.js. Dependency-free ESM, matching
// the other tools/*.mjs generators. Run via `npm run generate` (or generate:pricing).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
