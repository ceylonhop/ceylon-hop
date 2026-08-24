import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const destinations = [
  ['sigiriya', 'img/section-art/sigiriya.svg'],
  ['hiriketiya', 'img/section-art/hiriketiya-cove.svg'],
  ['hill-country-rail', 'img/section-art/hill-country-rail.svg'],
  ['mirissa-whale', 'img/section-art/mirissa-whale.svg'],
];

describe('homepage destination line art', () => {
  const html = read('index.html');
  const css = html;

  it('gives each otherwise-plain homepage section one distinct Sri Lankan scene', () => {
    const assigned = [...html.matchAll(/<section[^>]*data-destination-art="([^"]+)"[^>]*>/g)]
      .map((match) => match[1]);

    expect(assigned).toEqual(destinations.map(([name]) => name));
  });

  it('ships each scene as a decorative, text-free SVG asset', () => {
    for (const [, asset] of destinations) {
      expect(existsSync(path.join(root, asset)), `${asset} is missing`).toBe(true);
      const svg = read(asset);
      expect(svg).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(svg).not.toMatch(/<text\b/);
    }
  });

  it('keeps the artwork faint, non-interactive, and behind the content', () => {
    const art = css.match(/\.destination-art::after\{([^}]*)\}/)?.[1] || '';
    const content = css.match(/\.destination-art\s*>\s*\.wrap\{([^}]*)\}/)?.[1] || '';

    expect(art).toMatch(/pointer-events:\s*none/);
    expect(art).toMatch(/opacity:\s*\.08/);
    expect(art).toMatch(/z-index:\s*0/);
    expect(content).toMatch(/z-index:\s*1/);
  });

  it('reduces the decoration further on phones', () => {
    const mobile = css.match(/@media\(max-width:600px\)\{[\s\S]*?\/\* destination art: mobile restraint \*\/([\s\S]*?)\n\s*\}/)?.[1] || '';

    expect(mobile).toMatch(/\.destination-art::after\{[^}]*opacity:\s*\.05/);
    expect(mobile).toMatch(/max-width:\s*190px/);
  });

  it('keeps the destination rules scoped to the homepage', () => {
    expect(read('site.css')).not.toContain('.destination-art');
  });
});
