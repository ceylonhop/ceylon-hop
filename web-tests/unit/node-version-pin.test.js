import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = (f) => readFileSync(path.resolve(__dirname, '../..', f), 'utf8');

/* Production ran Node 26.7.0 while every CI job ran Node 20.

   `api/package.json` said ">=20" with no .nvmrc, so Render took the newest Node it had —
   six major versions ahead of anything the 2,400 API tests exercise. Nothing in the repo
   showed it; the only evidence was a line in a deploy log. A runtime the tests never run
   on can fail in ways no green build can predict, and did: POST /board 500'd on a
   TypeError from inside the Postgres driver while CI stayed green.

   These assertions keep the two in step. If CI moves to a newer Node, this fails until
   the engines field and .nvmrc move with it — which is the point. */

const MAJOR = /(\d+)/;

describe('the Node prod runs is the Node CI tests', () => {
  const ci = root('.github/workflows/ci.yml');
  const apiPkg = JSON.parse(root('api/package.json'));

  it('pins an exact major in engines rather than an open range', () => {
    const engines = apiPkg.engines?.node ?? '';
    expect(engines, 'api/package.json engines.node').toBeTruthy();
    expect(engines, 'an open range lets the host pick — that is how prod got Node 26')
      .not.toMatch(/^[>^~*]|\|\|/);
    expect(engines).toMatch(/^\d+\.x$/);
  });

  it('agrees with every node-version in the CI workflow', () => {
    const ciMajors = [...ci.matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => m[1]);
    expect(ciMajors.length, 'no node-version found in ci.yml').toBeGreaterThan(0);
    const pinned = apiPkg.engines.node.match(MAJOR)[1];
    for (const major of ciMajors) {
      expect(major, `ci.yml runs Node ${major} but engines pins ${pinned}`).toBe(pinned);
    }
  });

  it('ships an .nvmrc so local shells and the host agree too', () => {
    for (const f of ['.nvmrc', 'api/.nvmrc']) {
      const major = root(f).trim().match(MAJOR)?.[1];
      expect(major, `${f} major`).toBe(apiPkg.engines.node.match(MAJOR)[1]);
    }
  });
});
