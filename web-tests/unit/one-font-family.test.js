import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
  One font, everywhere (owner, 2026-10-29). The site had drifted to three faces — Bodoni
  for headings, Poppins for body, Caveat for notes — plus a monospace for booking codes.
  Bodoni was unreadable on Android (Bodoni Moda's hairlines break up at heading sizes),
  and the owner asked that every surface use one consistent font: Source Serif 4.

  site.css owns the choice through --font; --display/--body/--hand/--mono all point at it.
  This guard reads every customer-served page, stylesheet, script and generator, and fails
  if a retired face is named in a font declaration or requested from Google Fonts.
  Comments may still mention them (history), so declarations are matched, not bare words.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const SKIP_DIRS = new Set(['node_modules', '.git', 'api', 'docs', 'web-tests', 'img', '.claude']);
function files(dir = '') {
  const out = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith('.')) out.push(...files(rel));
    } else if (/\.(html|css|js|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}

const RETIRED = /bodoni|poppins|caveat|newsreader|hanken|jetbrains|didot|monospace/i;
// font-family: …;  font: … ;  font-family="…" (SVG attribute)
const DECLARATION = /font-family\s*[:=]\s*[^;}>]*|(?<![-\w])font\s*:\s*[^;}]*/gi;

describe('one font family on every surface', () => {
  const all = files();

  it('finds the surfaces it is meant to guard', () => {
    expect(all).toContain('site.css');
    expect(all).toContain('manage.html');
    expect(all).toContain(path.join('tools', 'generate-route-pages.mjs'));
    expect(all.some((f) => f.startsWith('trip' + path.sep))).toBe(true);
  });

  it('site.css points every font token at Source Serif 4', () => {
    const css = read('site.css');
    expect(css).toMatch(/--font:'Source Serif 4',/);
    for (const t of ['display', 'body', 'hand', 'mono']) {
      expect(css, `--${t}`).toMatch(new RegExp(`--${t}:var\\(--font\\);`));
    }
  });

  it('no file names a retired face in a font declaration', () => {
    const bad = [];
    for (const f of all) {
      for (const m of read(f).matchAll(DECLARATION)) {
        if (RETIRED.test(m[0])) bad.push(`${f}: ${m[0].trim().slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('Google Fonts is asked for Source Serif 4 and nothing else', () => {
    const bad = [];
    for (const f of all) {
      for (const m of read(f).matchAll(/fonts\.googleapis\.com\/css2\?[^"')\s]*/g)) {
        const families = [...m[0].matchAll(/family=([^:&]+)/g)].map((x) => x[1]);
        if (families.some((x) => x !== 'Source+Serif+4')) bad.push(`${f}: ${families.join(', ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // The API-served surfaces: the ops tool, every email, and the rasterised share cards.
  const API = [
    'api/src/routes/ops-ui.html',
    'api/src/services/notifications.ts',
    'api/src/services/rideBoardEmails.ts',
    'api/src/routes/shareCardImage.ts',
    'api/src/routes/quoteCard.ts',
    'api/src/routes/payCard.ts',
    'api/src/routes/shareCard.ts',
    'api/src/routes/customerPages.ts',
  ];

  it('the ops tool and emails name no retired face', () => {
    const bad = [];
    for (const f of API) {
      const s = read(f);
      for (const m of s.matchAll(DECLARATION)) if (RETIRED.test(m[0])) bad.push(`${f}: ${m[0].trim().slice(0, 90)}`);
      for (const m of s.matchAll(/const (?:SERIF|SANS|MONO) = "([^"]+)"/g)) if (RETIRED.test(m[1])) bad.push(`${f}: ${m[0]}`);
      for (const m of s.matchAll(/fonts\.googleapis\.com\/css2\?[^"')\s]*/g)) {
        if ([...m[0].matchAll(/family=([^:&]+)/g)].some((x) => x[1] !== 'Source+Serif+4')) bad.push(`${f}: ${m[0].slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('share cards bundle and name only Source Serif 4', () => {
    const fonts = readdirSync(path.join(root, 'api/assets/fonts')).filter((f) => f.endsWith('.ttf'));
    expect(fonts.sort()).toEqual(['SourceSerif4-Bold.ttf', 'SourceSerif4-Regular.ttf']);
    const img = read('api/src/routes/shareCardImage.ts');
    expect(img).toMatch(/export const DISPLAY = 'Source Serif 4';/);
    expect(img).toMatch(/export const BODY = 'Source Serif 4';/);
    for (const f of ['api/src/routes/shareCard.ts', 'api/src/routes/customerPages.ts']) {
      expect(read(f), f).not.toMatch(/BodoniModa|Poppins-/);
    }
  });
});
