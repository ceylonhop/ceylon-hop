// Generates the front-end copy of the place shortener from the backend module, so a place name is
// shortened by ONE implementation everywhere — ops, the pay page, emails and the trip planner.
//
// Owner, 2026-08-08, on how to stop the planner printing "Jaffna, Sri Lanka" beside "Colombo city":
// "do the better scalable future proof solution" — and earlier, on the per-surface approach: "why
// are we having all these changes made instead of pulling all the names from one place?"
//
// So the browser copy is COMPILED from api/src/quote/shortPlace.ts rather than hand-written. That
// buys drift protection for free: CI already re-runs `npm run generate` and fails if any generated
// file differs from what is committed, so the two copies cannot disagree — and an edit to the
// generated file is caught rather than quietly kept. Contrast ch-map.js, whose duplicate mapPins()
// needs a bespoke parity test to do the same job by hand.
//
// Dependency-free ESM, matching the other tools/*.mjs generators. Run via `npm run generate`.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'ch-shortplace.js');

export const SHORTPLACE_BEGIN =
  '/* @generated:shortplace — from api/src/quote/shortPlace.ts · DO NOT EDIT BY HAND · run `npm run generate` */';
export const SHORTPLACE_END = '/* @end:shortplace */';

// The whole file is generated, so there is no host file to splice into — render it start to end.
// Loaded as a classic <script> (the front-end has no module graph), hence the IIFE and the CH
// namespace rather than exports. The module.exports tail is what lets web-tests require it.
export function renderShortplaceModule(body) {
  const indented = body
    .split('\n')
    .map((line) => (line.trim() ? '  ' + line : line))
    .join('\n');
  return [
    SHORTPLACE_BEGIN,
    '(function (root) {',
    indented,
    '',
    '  root.CH = root.CH || {};',
    '  root.CH.shortPlace = shortPlace;',
    '  root.CH.shortenRouteLabel = shortenRouteLabel;',
    '  if (typeof module !== "undefined" && module.exports) {',
    '    module.exports = { shortPlace: shortPlace, shortenRouteLabel: shortenRouteLabel };',
    '  }',
    '})(typeof globalThis !== "undefined" ? globalThis : this);',
    SHORTPLACE_END,
    '',
  ].join('\n');
}

export function buildShortplaceBody() {
  return execFileSync('npm', ['run', '--silent', 'dump:shortplace'], {
    cwd: join(ROOT, 'api'),
    encoding: 'utf8',
  }).trimEnd();
}

// Only run when invoked directly, so the tests can import the pure pieces above.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, renderShortplaceModule(buildShortplaceBody()));
  console.log('✓ ch-shortplace.js generated from api/src/quote/shortPlace.ts');
}
