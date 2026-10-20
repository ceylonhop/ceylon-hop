// The two Ramayana tours on tours.html / tour.html?id=… (owner call 2026-10-17: both trips, chauffeur
// figure from the ops quote, and a plain note that temple visits need the chauffeur-guide option).
// Guards the tours against drifting from the landing page (tools/ramayana/trail.json) they sell.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadTransfers } from '../../tools/load-transfers.mjs';
import { loadRamayana, generateRamayana, RAMAYANA_PATH } from '../../tools/generate-ramayana.mjs';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = f => readFileSync(path.join(ROOT, f), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(read('tours-data.js'), sandbox, { filename: 'tours-data.js' });
const TOURS = sandbox.window.TOURS;
const T = loadTransfers();
const trail = loadRamayana();
const IDS = { gentle: 'ramayana-yatra', full: 'ramayana-trail' };

describe('Ramayana tours', () => {
  it('are appended after the existing tours, so TOURS[0] and the home/planner slices are unchanged', () => {
    expect(TOURS[0].id).toBe('classic-hop');
    expect(TOURS.slice(-2).map(t => t.id)).toEqual([IDS.gentle, IDS.full]);
  });
  for (const trip of trail.trips) {
    describe(IDS[trip.id], () => {
      const t = TOURS.find(x => x.id === IDS[trip.id]);
      it('matches the landing page trip: name, days and the ops-quote chauffeur price', () => {
        expect(t).toBeTruthy();
        expect(t.name).toBe(trip.name);
        expect(t.days).toBe(trip.days);
        expect(t.nights).toBe(trip.days - 1);
        expect(t.price).toBe(trip.price.car);
      });
      it('has one itinerary day per day, and every stop is a real catalogue place (no $55 placeholder legs)', () => {
        expect(t.itinerary).toHaveLength(t.days);
        const q = T.tripQuote(t.stops, 'car');
        expect(q.hasEst, q.legs.filter(l => l.est).map(l => `${l.from}→${l.to}`).join(', ')).toBe(false);
      });
      it('says plainly that the temple visits need the chauffeur-guide option', () => {
        expect(t.includes.join(' ')).toMatch(/temple visits need the chauffeur-guide/i);
      });
      it('never calls Ravana a demon', () => {
        expect(JSON.stringify(t).toLowerCase()).not.toContain('demon');
      });
      it('has a card photo and a gallery whose files exist', () => {
        const card = read('tours.html').match(new RegExp(`'${t.id}':'(img/[^']+)'`));
        expect(card, 'tours.html TOUR_PHOTO').toBeTruthy();
        expect(existsSync(path.join(ROOT, card[1])), card[1]).toBe(true);
        const block = read('tour.html').match(new RegExp(`'${t.id}':\\[([\\s\\S]*?)\\]\\s*,?\\s*\\n\\s*(?:'|\\})`));
        expect(block, 'tour.html TOUR_GALLERY').toBeTruthy();
        const files = [...block[1].matchAll(/\['(img\/[^']+)'/g)].map(m => m[1]);
        expect(files.length).toBeGreaterThanOrEqual(5);
        for (const f of files) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
      });
      it('the landing page links to it', () => {
        expect(generateRamayana().get(`${RAMAYANA_PATH}index.html`)).toContain(`href="../tour.html?id=${t.id}"`);
      });
    });
  }
});
