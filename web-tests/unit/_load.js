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
// Engine rate-card parity (owner decision 2026-07-02, api/src/quote/rateCard.ts):
//   billableKm = round(km × 1.10)   — +10% routing buffer
//   fare       = max(floor, round(billableKm × rate))
//   car: $0.46/km, $29 floor · van: $0.83/km, $50 floor
export const carFare = (km) => Math.max(29, Math.round(Math.round(km * 1.10) * 0.46));
export const vanFare = (km) => Math.max(50, Math.round(Math.round(km * 1.10) * 0.83));
