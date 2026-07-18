import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformHtml, PROD_GTM_ID, PROD_MAPS_KEY } from '../../tools/stage-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const API = 'https://ceylon-hop-api-staging.onrender.com';

describe('stage-config transformHtml (real index.html)', () => {
  it('sets window.CEYLON_HOP_API before the inline scripts that read it', () => {
    const out = transformHtml(indexHtml, { apiUrl: API });
    expect(out).toContain(`window.CEYLON_HOP_API=${JSON.stringify(API)}`);
    // Injection must appear before the error-beacon line that reads the fallback.
    const injectAt = out.indexOf('window.CEYLON_HOP_API=');
    const beaconAt = out.indexOf("window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com'");
    expect(injectAt).toBeGreaterThan(-1);
    expect(beaconAt).toBeGreaterThan(injectAt);
  });

  it('injects right after <head> (runs before other head scripts)', () => {
    const out = transformHtml(indexHtml, { apiUrl: API });
    const headAt = out.search(/<head[^>]*>/i);
    const injectAt = out.indexOf('CH_STAGING_CONFIG');
    const mapsKeyAt = out.indexOf("window.CEYLON_MAPS_KEY='");
    expect(injectAt).toBeGreaterThan(headAt);
    expect(injectAt).toBeLessThan(mapsKeyAt); // before the existing head scripts
  });

  it('adds a noindex robots meta', () => {
    const out = transformHtml(indexHtml, { apiUrl: API });
    expect(out).toMatch(/<meta name="robots" content="noindex,nofollow">/);
  });

  it('neutralizes the GTM container so no tags fire on staging', () => {
    expect(indexHtml).toContain(PROD_GTM_ID); // fixture sanity
    const out = transformHtml(indexHtml, { apiUrl: API });
    expect(out).not.toContain(PROD_GTM_ID);
    expect(out).toContain('GTM-DISABLED-ON-STAGING');
  });

  it('leaves the prod Maps key unless STAGING_MAPS_KEY is given, then swaps it', () => {
    const asIs = transformHtml(indexHtml, { apiUrl: API });
    expect(asIs).toContain(PROD_MAPS_KEY);
    const swapped = transformHtml(indexHtml, { apiUrl: API, mapsKey: 'AIzaSTAGINGKEY' });
    expect(swapped).not.toContain(PROD_MAPS_KEY);
    expect(swapped).toContain('AIzaSTAGINGKEY');
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = transformHtml(indexHtml, { apiUrl: API });
    const twice = transformHtml(once, { apiUrl: API });
    expect(twice).toBe(once);
  });

  it('requires an apiUrl', () => {
    expect(() => transformHtml(indexHtml, {})).toThrow(/apiUrl/);
  });

  it('leaves a non-HTML string untouched', () => {
    expect(transformHtml('just some text, no head', { apiUrl: API })).toBe('just some text, no head');
  });
});
