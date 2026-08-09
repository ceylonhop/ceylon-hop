// Prints the browser build of the canonical place-shortener on stdout. Consumed by
// tools/generate-shortplace.mjs (root, dependency-free) via `npm run --silent dump:shortplace`.
//
// src/quote/shortPlace.ts stays the ONE implementation. The front-end copy is COMPILED from it
// rather than hand-written, so the two cannot drift: CI re-runs `npm run generate` and fails on
// any diff. This is the same shape as dump-pricing.ts, except it carries logic rather than data.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const SRC = new URL('../src/quote/shortPlace.ts', import.meta.url);

// `export` is stripped before transpiling so the emitted code is plain top-level declarations —
// the browser copy is loaded as a classic <script>, not a module. shortPlace.ts has no imports,
// so nothing else needs rewriting; if that ever changes this script must be revisited.
const source = readFileSync(SRC, 'utf8');
if (/^\s*import\s/m.test(source)) {
  throw new Error('shortPlace.ts gained an import — the generated browser copy can no longer be a flat transpile');
}

const { outputText } = ts.transpileModule(source.replace(/^export /gm, ''), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.None,
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  },
});

process.stdout.write(outputText.trimEnd() + '\n');
