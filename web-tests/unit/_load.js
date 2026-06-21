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

// The 16 known places that carry an id (the bookable catalogue).
export const PLACE_IDS = [
  'cmb-airport', 'colombo', 'negombo', 'bentota', 'hikkaduwa', 'galle',
  'weligama', 'mirissa', 'kandy', 'nuwara-eliya', 'ella', 'sigiriya',
  'anuradhapura', 'yala', 'arugam-bay', 'trincomalee',
];

// Pricing formulas mirrored from transfers-data.js — the tests assert the
// shipped functions match these, so a silent formula drift is caught.
export const carFare = (km) => Math.max(28, Math.round(22 + km * 0.62));
export const vanFare = (km) => Math.max(38, Math.round(30 + km * 0.86));
