import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Solid buttons carry white body text at .97rem/600 — below the WCAG "large text"
// threshold (18.66px bold), so they need the full 4.5:1, not 3:1.
//
// This has regressed once already: btn-wa's base was fixed from #25D366 (1.98:1)
// to #0B7A44, but its :hover was left at #1ebe5a (2.45:1), so hovering put it
// straight back under the bar. This test reads the real values out of site.css so
// a future edit to the fill colours fails here instead of shipping.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSS = readFileSync(path.join(root, 'site.css'), 'utf8');
const INDEX = readFileSync(path.join(root, 'index.html'), 'utf8');

const relLuminance = (hex) => {
  const h = hex.replace('#', '');
  const c = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

const contrastOnWhite = (hex) => 1.05 / (relLuminance(hex) + 0.05);

/** Pull a `--token:#rrggbb` declaration out of site.css. */
function token(name) {
  const m = CSS.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found in site.css`);
  return m[1];
}

/** Pull the `background:#rrggbb` out of a rule like `.btn-wa:hover{...}`. */
function ruleBackground(selector) {
  const m = CSS.match(
    new RegExp(`${selector.replace(/[.:]/g, '\\$&')}\\s*\\{[^}]*background:\\s*(#[0-9a-fA-F]{6})`),
  );
  if (!m) throw new Error(`background for ${selector} not found in site.css`);
  return m[1];
}

describe('button fills meet WCAG AA against white text', () => {
  const cases = [
    ['--btn-accent', () => token('btn-accent')],
    ['--btn-accent-hover', () => token('btn-accent-hover')],
    ['--btn-cta', () => token('btn-cta')],
    ['--btn-cta-hover', () => token('btn-cta-hover')],
    ['.btn-wa', () => ruleBackground('.btn-wa')],
    ['.btn-wa:hover', () => ruleBackground('.btn-wa:hover')],
  ];

  for (const [label, get] of cases) {
    it(`${label} is at least 4.5:1`, () => {
      const ratio = contrastOnWhite(get());
      expect(ratio, `${label} = ${get()} is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }

  // The accent tokens themselves are intentionally left bright — they are used for
  // hairlines, focus rings and icons, which carry no text. This asserts the button
  // tokens stay decoupled from them, which is the mistake this whole fix undoes.
  it('button fills are not aliased back to the bright accent tokens', () => {
    expect(CSS).toMatch(/\.btn-primary\{background:var\(--btn-accent\)/);
    expect(CSS).toMatch(/\.btn-cta\{background:var\(--btn-cta\)/);
  });
});

// Two more buttons live outside site.css entirely and have already drifted back to
// bright fills once: the PayHere handoff overlay's retry button (booking.html's inline
// <style>) and the transactional-consent accept button (consent-transactional.js's
// injected CSS). Same rule as above: white text, so the fill needs 4.5:1.
describe('buttons styled outside site.css meet WCAG AA against white text', () => {
  const BOOKING = readFileSync(path.join(root, 'booking.html'), 'utf8');
  const CONSENT = readFileSync(path.join(root, 'consent-transactional.js'), 'utf8');

  /** Resolve `#hex` or `var(--x,fallback)` against site.css, following var chains. */
  function resolve(value) {
    let v = value.trim();
    for (let hops = 0; v.startsWith('var(') && hops < 5; hops++) {
      const name = v.match(/var\(--([\w-]+)/)[1];
      const decl = CSS.match(new RegExp(`--${name}\\s*:\\s*([^;}]+)`));
      if (!decl) throw new Error(`--${name} not found in site.css`);
      v = decl[1].trim();
    }
    const hex = v.match(/#[0-9a-fA-F]{6}/);
    if (!hex) throw new Error(`${value} did not resolve to a hex colour (got "${v}")`);
    return hex[0];
  }

  const cases = [
    ['.ph-btn-primary', BOOKING, /\.ph-btn-primary\{[^}]*background:\s*([^;}]+)/],
    ['.ph-btn-primary:hover', BOOKING, /\.ph-btn-primary:hover\{[^}]*background:\s*([^;}]+)/],
    ['consent accept button', CONSENT, /data-consent="granted"[^{]*\{[^}]*background:\s*([^;}]+)/],
  ];

  for (const [label, src, re] of cases) {
    it(`${label} is at least 4.5:1`, () => {
      const m = src.match(re);
      if (!m) throw new Error(`background for ${label} not found`);
      const fill = resolve(m[1]);
      const ratio = contrastOnWhite(fill);
      expect(ratio, `${label} = ${fill} is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// The homepage hero booker opts out of .btn-cta's fill with its own gradient, defined
// in index.html's inline <style>. It is the most important button on the site, so it
// gets its own check — the site.css tokens above do not protect it.
describe('the hero booker gradient meets WCAG AA', () => {
  const stops = () => {
    const m = INDEX.match(/\.book-go\{[\s\S]*?background:linear-gradient\(180deg,\s*(#[0-9a-fA-F]{6}),\s*([^)]+)\)/);
    if (!m) throw new Error('.book-go gradient not found in index.html');
    const bottom = m[2].trim();
    // The bottom stop is a var() — resolve it against site.css.
    const resolved = bottom.startsWith('var(')
      ? token(bottom.replace(/var\(--|\)/g, ''))
      : bottom;
    return [m[1], resolved];
  };

  it('both gradient stops are at least 4.5:1 on white', () => {
    for (const stop of stops()) {
      const ratio = contrastOnWhite(stop);
      expect(ratio, `hero gradient stop ${stop} is only ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
