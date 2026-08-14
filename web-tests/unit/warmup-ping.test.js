import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

// Every page that will show an API-priced figure must wake the instance on load. A cold Render
// free-tier start is measured in tens of seconds; the visitor should spend it reading, not waiting.
const PRICE_PAGES = ['index.html', 'why.html', 'tours.html', 'tour.html', 'search.html', 'plan.html'];

describe('price-bearing pages warm the API', () => {
  for (const page of PRICE_PAGES) {
    it(`${page} pings /health on load`, () => {
      const src = readFileSync(path.join(root, page), 'utf8');
      expect(src).toContain("/health");
    });
  }
});
