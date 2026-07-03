import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// transfers-data.js is a browser IIFE that assigns window.TRANSFERS and touches
// no DOM. Evaluate it in a sandbox with a window shim and hand back TRANSFERS —
// the single source of truth for distances and engine-parity prices, so the
// generator (and its tests) can never diverge from what the site charges.
export function loadTransfers() {
  const src = readFileSync(join(ROOT, 'transfers-data.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'transfers-data.js' });
  if (!sandbox.window.TRANSFERS) {
    throw new Error('transfers-data.js did not define window.TRANSFERS');
  }
  return sandbox.window.TRANSFERS;
}
