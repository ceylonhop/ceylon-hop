import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headAssets, analyticsSnippet } from '../../tools/site-chrome.mjs';
import { generateAll } from '../../tools/generate-route-pages.mjs';
import { generateStaticPages } from '../../tools/generate-static-pages.mjs';
const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// The 10 HAND-AUTHORED pages. Generated pages (terms/privacy/404/trip/*) get the
// snippet via headAssets + `npm run generate` (Task 9b), covered by seo-codegen.
const PAGES = ['index.html','booking.html','search.html','plan.html','about.html','blog.html','why.html','tours.html','tour.html','manage.html','board.html'];

describe('analytics snippet (Phase 0)', () => {
  it('sets Consent Mode v2 defaults before GTM loads', () => {
    // consent default must appear BEFORE the GTM loader in the string
    const iConsent = analyticsSnippet.indexOf("consent','default'");
    const iGtm = analyticsSnippet.indexOf('GTM-NL6K22CM');
    expect(iConsent).toBeGreaterThan(-1);
    expect(iGtm).toBeGreaterThan(-1);
    expect(iConsent).toBeLessThan(iGtm);
  });

  /* Owner decision 2026-08-16: no banner, analytics collected by default. Denying
     analytics_storage with nothing left to grant it is what sent every hit out as gcs=G100
     and made prod report zero visitors, so the default has to be 'granted' — a missing
     analytics_storage key would silently reinstate that bug, hence the explicit assertion. */
  it('grants analytics storage by default', () => {
    expect(analyticsSnippet).toContain("analytics_storage:'granted'");
    expect(analyticsSnippet).not.toContain("analytics_storage:'denied'");
  });

  /* The site runs no ads. These stay pinned so an ads tag added inside the GTM container
     cannot start setting advertising cookies without this line changing first. */
  it('hard-denies every advertising signal', () => {
    expect(analyticsSnippet).toContain("ad_storage:'denied'");
    expect(analyticsSnippet).toContain("ad_user_data:'denied'");
    expect(analyticsSnippet).toContain("ad_personalization:'denied'");
    for (const k of ['ad_storage', 'ad_user_data', 'ad_personalization']) {
      expect(analyticsSnippet, `${k} must never be granted`).not.toContain(`${k}:'granted'`);
    }
  });

  /* wait_for_update existed to hold hits back while a banner was on screen. With no banner
     it delays every hit by half a second and never resolves into anything. */
  it('does not wait for a consent update that can never come', () => {
    expect(analyticsSnippet).not.toContain('wait_for_update');
  });

  it('loads the GTM container and the analytics helper via headAssets (with path prefix)', () => {
    const out = headAssets('../');
    expect(out).toContain('GTM-NL6K22CM');
    expect(out).toMatch(/src="\.\.\/analytics\.js(\?v=\w+)?"/);
    expect(out).not.toMatch(/consent[-\w]*\.js/);
  });

  it('carries no API secrets — only publishable IDs', () => {
    expect(analyticsSnippet).not.toMatch(/secret|token|api_secret/i);
  });
});

describe('analytics snippet present on every hand-authored root page', () => {
  it('has GTM + consent default + helper includes on all 10 pages', () => {
    for (const p of PAGES) {
      const html = read(p);
      expect(html.includes('GTM-NL6K22CM'), `${p} missing GTM`).toBe(true);
      expect(html.includes("consent','default'"), `${p} missing consent default`).toBe(true);
      expect(html.includes('analytics.js'), `${p} missing analytics.js`).toBe(true);
      expect(html.includes("analytics_storage:'granted'"), `${p} is not granting analytics`).toBe(true);
    }
  });
});

/* The banner is gone (owner, 2026-08-16) and the two scripts that drew it are deleted. This
   sweeps EVERY page rather than the hand-authored ten, because a stale <script src> would
   404 silently on the generated pages — and a page that still shipped consent.js would sit
   there waiting to overwrite the granted default with whatever localStorage remembered. */
describe('no consent banner ships anywhere', () => {
  it('no page references consent.js or consent-transactional.js', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'api') continue;
        const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.html') && /src="[^"]*consent[-\w]*\.js/.test(read(rel))) offenders.push(rel);
      }
    };
    walk('.');
    expect(offenders, `pages still loading a consent script: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the banner scripts are not in the repo', () => {
    expect(existsSync(join(ROOT, 'consent.js'))).toBe(false);
    expect(existsSync(join(ROOT, 'consent-transactional.js'))).toBe(false);
  });
});

/* The loader used to run wherever a page was opened. Clarity and GA4 count a SESSION per
   page load, so the e2e suite (~100 spec files against a localhost static server) invented
   several hundred "live users" per CI run, and every local preview added more.

   chEnv() cannot fix this — it only LABELS data with ch_env, and by the time it runs GTM
   has loaded and Clarity is already recording. The gate has to be in the head, ahead of
   the loader, which is what these guard. */
describe('analytics does not load off a real host', () => {
  // Pull the guard out of the SHIPPED string and execute it, so this tests the bytes that
  // actually reach the browser rather than a copy of the logic.
  const guard = (hostname) => {
    const m = analyticsSnippet.match(/if\((![\s\S]*?)\)return;/);
    expect(m, 'no hostname guard found in analyticsSnippet').toBeTruthy();
    return new Function('location', `return ${m[1]};`)({ hostname });
  };

  it('skips GTM on localhost, loopback, file:// and preview hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '', '0.0.0.0', 'ceylonhop.github.io']) {
      expect(guard(h), `${h || '(file://)'} should NOT load analytics`).toBe(true);
    }
  });

  it('still loads GTM on the real hosts', () => {
    for (const h of ['ceylonhop.com', 'www.ceylonhop.com', 'prod.ceylonhop.com',
      'pay.ceylonhop.com', 'ops.staging.ceylonhop.com', 'ceylon-hop-api.onrender.com']) {
      expect(guard(h), `${h} SHOULD load analytics`).toBe(false);
    }
  });

  it('is not fooled by lookalike hostnames', () => {
    for (const h of ['evil-ceylonhop.com', 'ceylonhop.com.evil.example', 'notceylonhop.com']) {
      expect(guard(h), `${h} must not be treated as ours`).toBe(true);
    }
  });

  it('the guard runs BEFORE the GTM script is injected', () => {
    expect(analyticsSnippet.indexOf(')return;')).toBeLessThan(analyticsSnippet.indexOf('googletagmanager.com'));
  });

  it('every hand-authored page carries the gate, not just the generated ones', () => {
    for (const p of PAGES) {
      expect(read(p).includes(")return;w[l]=w[l]||[];"), `${p} has an UNGATED GTM loader`).toBe(true);
    }
  });
});

describe('privacy disclosure', () => {
  it('the privacy source fragment mentions analytics cookies and opt-out', () => {
    const src = read('tools/legal/privacy.body.html').toLowerCase();
    expect(src).toContain('analytics');
    expect(src).toContain('cookie');
  });

  /* The policy is the only thing left telling a visitor what we collect, so it has to match
     the code. It used to promise a banner and advertising cookies; both claims are now false
     and a false privacy policy is worse than a thin one. */
  it('does not promise a cookie banner that no longer exists', () => {
    const src = read('tools/legal/privacy.body.html').toLowerCase();
    expect(src).not.toContain('cookie banner');
    expect(src).not.toContain('until you accept');
  });

  /* Matched on the AFFIRMATIVE claim, not the bare phrase: the replacement copy says "we do
     not use advertising cookies and we do not personalise ads", so a naive
     not.toContain('personalise ads') fails on the very sentence that makes it true. */
  it('does not claim advertising cookies the site no longer sets', () => {
    const src = read('tools/legal/privacy.body.html').toLowerCase();
    expect(src).not.toContain('advertising cookies (via google)');
    expect(src).toContain('we do not use advertising cookies');
    expect(src).toContain('we do not personalise ads');
  });
});

describe('generated pages carry the analytics snippet', () => {
  it('a route page and the generated privacy page include GTM', () => {
    const all = new Map([...generateAll(), ...generateStaticPages()]);
    const route = all.get('trip/kandy-to-ella/index.html');
    expect(route, 'route page missing').toBeTruthy();
    expect(route).toContain('GTM-NL6K22CM');
    expect(all.get('privacy.html')).toContain('GTM-NL6K22CM');
  });
  it('the regenerated privacy page carries the analytics disclosure', () => {
    const all = new Map([...generateStaticPages()]);
    expect(all.get('privacy.html').toLowerCase()).toContain('analytics');
  });
});
