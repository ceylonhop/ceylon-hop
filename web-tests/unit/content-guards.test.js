// Copy guards for the guide + FAQ sources, from the 2026-10-17 content review. Each one pins a
// mistake that shipped once: Ravana called a "demon" (house wording rule), the pre-2-Oct-2026
// "trains turn back at Rambukkana" line, an arrivals meet-and-greet we don't run (PR #679 rule),
// and the Seetha Amman temple placed at Ramboda (it's the Hanuman temple there; Seetha Amman is
// at Seetha Eliya, on the Hakgala side).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUIDES = path.join(ROOT, 'tools/guides');
const sources = [
  ...readdirSync(GUIDES).filter(f => f.endsWith('.json')).map(f => path.join(GUIDES, f)),
  path.join(ROOT, 'tools/faq/sri-lanka.json'),
].map(file => ({ name: path.relative(ROOT, file), text: readFileSync(file, 'utf8') }));

describe('content guards (guides + FAQ sources)', () => {
  it('reads every guide and the FAQ', () => {
    expect(sources.length).toBeGreaterThanOrEqual(9);
  });
  for (const { name, text } of sources) {
    it(`${name} avoids banned phrases`, () => {
      expect(text, 'never call Ravana a "demon"').not.toMatch(/demon/i);
      expect(text, 'trains run to Peradeniya/Gampola since 2 Oct 2026').not.toMatch(/Rambukkana/i);
      expect(text, 'no arrivals meet-and-greet').not.toMatch(/meet you at arrivals/i);
      expect(text, 'no derailment history (owner, 2026-10-17)').not.toMatch(/derail/i);
      expect(text, 'no hill-line reopening date: the railway has not given one').not.toMatch(/reopen[^.]*202[6-9]|aiming for the end of/i);
    });
  }
  it('guides and trip-page copy promise an airport pickup, not a driver who meets you', () => {
    const copy = [
      ...sources.filter(s => s.name.startsWith('tools/guides/')),
      { name: 'tools/route-content.json', text: readFileSync(path.join(ROOT, 'tools/route-content.json'), 'utf8') },
    ];
    for (const { name, text } of copy) expect(text, name).not.toMatch(/meets? you/i);
  });
  it('nuwara-eliya.json does not put Seetha Amman in a Ramboda stop', () => {
    const ne = JSON.parse(sources.find(s => s.name.endsWith('nuwara-eliya.json')).text);
    for (const stop of ne.onTheWay.stops) {
      const blob = [stop.km, stop.name, stop.text, stop.wa].join(' ');
      if (/Ramboda/i.test(blob)) expect(blob).not.toMatch(/Seetha Amman/i);
    }
  });
});
