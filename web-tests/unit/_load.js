import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// transfers-data.js is a browser IIFE that assigns `window.TRANSFERS`. It has no
// DOM dependencies, so we can execute it in the jsdom global scope and read the
// exported API back out — no source changes needed.
export function loadTransfers() {
  if (typeof window === 'undefined') {
    throw new Error('loadTransfers requires the jsdom environment (vitest environment: jsdom).');
  }
  const src = readFileSync(path.resolve(__dirname, '../../transfers-data.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  return window.TRANSFERS;
}

// routes-data.js is a browser IIFE that assigns `window.ROUTES` — same trick.
export function loadRoutes() {
  if (typeof window === 'undefined') {
    throw new Error('loadRoutes requires the jsdom environment (vitest environment: jsdom).');
  }
  const src = readFileSync(path.resolve(__dirname, '../../routes-data.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  return window.ROUTES;
}

// The 16 known places that carry an id (the bookable catalogue).
export const PLACE_IDS = [
  'cmb-airport', 'colombo', 'negombo', 'bentota', 'hikkaduwa', 'galle',
  'weligama', 'mirissa', 'kandy', 'nuwara-eliya', 'ella', 'sigiriya',
  'anuradhapura', 'yala', 'arugam-bay', 'trincomalee',
];

// Pricing formulas mirrored from transfers-data.js — the tests assert the
// shipped functions match these, so a silent formula drift is caught.
// Engine rate-card parity (owner update 2026-07-13, api/src/quote/rateCard.ts):
//   billableKm = km + clamp(round(km × 0.10), 5, 15)
//   fare       = max(floor, round(billableKm × rate))   — rate is SELL = cost × 1.15
//   car: $0.4025/km, $29 floor · van: $0.5405/km, $50 floor
const billableKm = (km) => km + Math.min(15, Math.max(5, Math.round(km * 0.10)));
export const carFare = (km) => Math.max(29, Math.round(billableKm(km) * 0.4025));
export const vanFare = (km) => Math.max(50, Math.round(billableKm(km) * 0.5405));
