import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* The homepage's six "Popular transfers" cards go to search.html — the SAME page the hero search
   lands on. Owner decision 2026-09-19: a pair has one place on the site, not two. #591 had sent
   these to /trip/<from>-to-<to>/, so a card and a search for the same pair showed different
   pages. The /trip/ pages stay as landing pages for visitors arriving from outside; the on-site
   journey does not route through them. */

const pairs = () => {
  const m = INDEX.match(/const POP_TRANSFERS\s*=\s*\[(.*?)\];/s);
  expect(m, 'POP_TRANSFERS not found in index.html').toBeTruthy();
  return [...m[1].matchAll(/\['([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'\]/g)].map((x) => [x[1], x[2]]);
};

describe('homepage popular-transfer cards', () => {
  it('names at least the six pairs the design calls for', () => {
    expect(pairs().length).toBeGreaterThanOrEqual(6);
  });

  it('sends every card to search.html, built from the pair', () => {
    expect(INDEX).toContain('const u=new URLSearchParams({from:f,to:t}).toString();');
    expect(INDEX).toContain('<a class="card tcard reveal" href="search.html?${u}">');
  });

  it('does not send a card to a /trip/ page — one place per pair', () => {
    expect(INDEX).not.toMatch(/class="card tcard[^"]*" href="trip\//);
  });
});
