#!/usr/bin/env node
// Build-time staging transform for the static site. Runs ONLY in the staging host's build
// (e.g. the Render static-site buildCommand) over a copy of the site — it never modifies the
// committed source, so the production build (GitHub Pages from `production`) is byte-identical
// to what's in git. That's the whole safety story: prod can't accidentally inherit staging config.
//
// What it does to each *.html:
//   1. Points the front-end at the staging API by setting window.CEYLON_HOP_API before the
//      inline scripts that read it (booking flow + the error beacon), so staging traffic and
//      staging errors go to the staging API — never prod.
//   2. Adds <meta name="robots" content="noindex,nofollow"> so the staging site is never indexed.
//   3. Neutralizes the shared GTM container id (analytics off, defense-in-depth on top of the
//      hostname gate in analytics.js's chIsProd()).
//   4. Optionally swaps the public browser Maps key for a staging-scoped one (STAGING_MAPS_KEY).
//
//   STAGING_API_URL=https://ceylon-hop-api-staging.onrender.com \
//   [STAGING_MAPS_KEY=AIza…] node tools/stage-config.mjs <dir>
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// The prod browser Maps key literal embedded in the committed HTML (index.html). Swapped for a
// staging key only when STAGING_MAPS_KEY is set; harmless no-op otherwise.
export const PROD_MAPS_KEY = 'AIzaSyDY-pFmqV4eIax2hhsdj96YD1c8Em-srCI';
export const PROD_GTM_ID = 'GTM-NL6K22CM';
const MARKER = 'CH_STAGING_CONFIG';

// Pure transform — the CLI applies this to files; tests exercise it directly on a string.
export function transformHtml(html, { apiUrl, mapsKey } = {}) {
  if (!apiUrl) throw new Error('transformHtml requires an apiUrl');
  if (html.includes(MARKER)) return html; // idempotent — already staged

  const inject =
    `\n<!-- ${MARKER} -->\n` +
    `<meta name="robots" content="noindex,nofollow">\n` +
    `<script>window.CEYLON_HOP_API=${JSON.stringify(apiUrl)};window.CH_STAGING=true;</script>\n`;

  let out = html;
  const headMatch = out.match(/<head[^>]*>/i);
  if (!headMatch) return html; // not an HTML doc with a <head> — leave untouched
  out = out.replace(headMatch[0], headMatch[0] + inject);

  // Neutralize analytics: point the loader at a non-existent container so no tags fire.
  out = out.split(PROD_GTM_ID).join('GTM-DISABLED-ON-STAGING');

  // Optional: swap the public browser Maps key for a staging-scoped one.
  if (mapsKey) out = out.split(PROD_MAPS_KEY).join(mapsKey);

  return out;
}

function walkHtml(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkHtml(full, acc);
    else if (entry.endsWith('.html')) acc.push(full);
  }
  return acc;
}

// CLI entry — only runs when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || '.';
  const apiUrl = process.env.STAGING_API_URL;
  const mapsKey = process.env.STAGING_MAPS_KEY;
  if (!apiUrl) {
    console.error('STAGING_API_URL is required, e.g. STAGING_API_URL=https://ceylon-hop-api-staging.onrender.com node tools/stage-config.mjs .');
    process.exit(1);
  }
  const files = walkHtml(path.resolve(dir));
  let changed = 0;
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    const after = transformHtml(before, { apiUrl, mapsKey });
    if (after !== before) {
      writeFileSync(f, after);
      changed++;
    }
  }
  console.log(`stage-config: pointed ${changed}/${files.length} HTML files at ${apiUrl} (noindex + analytics off).`);
}
