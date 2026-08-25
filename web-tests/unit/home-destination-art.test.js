import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const destinations = [
  ['sigiriya', 'img/section-art/sigiriya-watercolor.webp'],
  ['hiriketiya', 'img/section-art/hiriketiya-cove-watercolor.webp'],
  ['hill-country-rail', 'img/section-art/hill-country-rail-watercolor.webp'],
  ['mirissa-whale', 'img/section-art/mirissa-whale-watercolor.webp'],
];

describe('homepage destination editorial art', () => {
  const html = read('index.html');
  const css = html;

  it('gives each otherwise-plain homepage section one distinct Sri Lankan scene', () => {
    const assigned = [...html.matchAll(/<section[^>]*data-destination-art="([^"]+)"[^>]*>/g)]
      .map((match) => match[1]);

    expect(assigned).toEqual(destinations.map(([name]) => name));
  });

  it('ships each scene as a compact WebP illustration', () => {
    for (const [, asset] of destinations) {
      expect(existsSync(path.join(root, asset)), `${asset} is missing`).toBe(true);
      const image = readFileSync(path.join(root, asset));
      expect(image.subarray(0, 4).toString()).toBe('RIFF');
      expect(image.subarray(8, 12).toString()).toBe('WEBP');
      expect(image.includes(Buffer.from('ALPH')), `${asset} lost its transparent background`).toBe(true);
      expect(statSync(path.join(root, asset)).size).toBeLessThan(350_000);
    }
  });

  it('keeps the artwork faint, non-interactive, and behind the content', () => {
    const art = css.match(/\.destination-art::after\{([^}]*)\}/)?.[1] || '';
    const content = css.match(/\.destination-art\s*>\s*\.wrap\{([^}]*)\}/)?.[1] || '';

    expect(art).toMatch(/pointer-events:\s*none/);
    expect(art).toMatch(/opacity:\s*\.30/);
    expect(art).toMatch(/z-index:\s*0/);
    expect(content).toMatch(/z-index:\s*1/);
  });

  it('reduces the decoration further on phones', () => {
    const mobile = css.match(/@media\(max-width:600px\)\{[\s\S]*?\/\* destination art: mobile restraint \*\/([\s\S]*?)\n\s*\}/)?.[1] || '';

    expect(mobile).toMatch(/\.destination-art::after\{[^}]*opacity:\s*\.18/);
    expect(mobile).toMatch(/max-width:\s*260px/);
  });

  it('keeps the destination rules scoped to the homepage', () => {
    expect(read('site.css')).not.toContain('.destination-art');
  });
});
