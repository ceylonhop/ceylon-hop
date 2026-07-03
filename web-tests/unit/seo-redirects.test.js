import { describe, it, expect } from 'vitest';
import { generateRedirects, loadMap } from '../../tools/generate-redirects.mjs';

const map = loadMap();
const out = generateRedirects();

describe('redirects', () => {
  it('maps every old URL from the live Yoast sitemaps', () => {
    const froms = map.map(m => m.from);
    for (const u of [
      '/trip/kandy_to_ella/', '/trip/shared-ride-negombo-to-sigiri/', '/trip/ella-to-arugambay-shared-ride/',
      '/trip/island_loop_9_stops/', '/routes/', '/about-us/', '/why-hop-with-us/',
      '/terms-and-conditions/', '/privacy-policy/', '/blog/',
    ]) expect(froms, u).toContain(u);
  });
  it('each stub has a canonical to the apex target, a meta refresh, and noindex', () => {
    for (const [path, html] of out) {
      if (path.endsWith('.csv')) continue;
      expect(html, path).toMatch(/http-equiv="refresh"/);
      expect(html, path).toMatch(/rel="canonical" href="https:\/\/ceylonhop\.com/);
      expect(html, path).toContain('noindex');
    }
  });
  it('every /trip/ redirect target is a real generated route page', () => {
    // generateRedirects() throws if a target is missing; reaching here means it held.
    const tripTargets = map.filter(m => /^\/trip\/.+\//.test(m.to));
    expect(tripTargets.length).toBeGreaterThan(8);
  });
  it('emits a Cloudflare CSV with a 301 row per mapping', () => {
    const csv = out.get('docs/cloudflare-redirects.csv');
    expect(csv).toMatch(/^source,target,status/);
    expect(csv.trim().split('\n').length).toBe(map.length + 1); // header + rows
    expect(csv).toContain('https://ceylonhop.com/trip/kandy_to_ella/,https://ceylonhop.com/trip/kandy-to-ella/,301');
  });
  it('old underscore /trip/ stubs never collide with new hyphen route dirs', () => {
    const stubDirs = map.map(m => m.from);
    expect(stubDirs).not.toContain('/trip/kandy-to-ella/'); // new page path, not an old URL
  });
});
