import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAll, ROOT } from '../../tools/generate-route-pages.mjs';

// Guards against drift: every committed generated file must equal what the
// generator produces from the current data. If this fails, run `npm run generate`.
describe('generated files match the generator (no drift)', () => {
  for (const [rel, content] of generateAll()) {
    it(rel, () => {
      let onDisk;
      try { onDisk = readFileSync(join(ROOT, rel), 'utf8'); }
      catch { throw new Error(`missing generated file ${rel} — run: npm run generate`); }
      expect(onDisk).toBe(content);
    });
  }
});
