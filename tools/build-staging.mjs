// tools/build-staging.mjs
// Assemble the copy of the site that Cloudflare Pages publishes at staging.ceylonhop.com.
//
// Run by Cloudflare's build, never committed: `node tools/build-staging.mjs` → .dist-staging/.
// The output directory is dot-prefixed on purpose: several unit tests walk the repo root for
// pages and skip dot-entries, so a local build cannot leak a second copy of every page into
// their view. copyTree skips dot-entries too, so the output can never contain itself.
// Nothing in the repo is modified, so no `@generated:` block is touched and the codegen and
// parity tests stay green. See docs/apex-cutover-runbook.md §7.
//
// The one thing it changes is where the staged site sends its API calls. Every page reads
//   window.CEYLON_HOP_API || '<some prod host>'
// so setting the variable ahead of the page's own script is enough — the `||` keeps our
// value and the page's fallback string stays in the file, unused. That is why the injection
// goes immediately after <head> and why the test asserts POSITION rather than absence: a
// build that appended the assignment would grep as correct and point staging at production,
// where a test booking is a real booking on a real card.
//
// robots.txt is overwritten with a blanket Disallow. Cloudflare Access already keeps
// crawlers out; this is the second lock, for the day someone loosens the first.
import { readdirSync, statSync, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGING_API = 'https://ops.staging.ceylonhop.com';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!-- ch:staging -->';

/** Repo furniture and other apps — everything else at the root IS the site. */
const SKIP_DIRS = new Set(['api', 'docs', 'tools', 'web-tests', 'node_modules', '.git', '.github', '.claude']);
const SKIP_FILES = new Set(['CNAME', 'package.json', 'package-lock.json', 'serve-booking.js']);

const HEAD_OPEN = /<head\b[^>]*>/i;

/**
 * Inject the staging API base + a noindex, immediately after <head> so both land ahead of
 * whatever the page does next. Idempotent, and loud rather than silent on a page it cannot
 * stamp — an unstamped page is one that talks to production.
 */
export function stampHtml(html) {
  if (html.includes(MARKER)) return html;
  const head = HEAD_OPEN.exec(html);
  if (!head) throw new Error('build-staging: page has no <head> to stamp — refusing to publish it pointed at production');
  const at = head.index + head[0].length;
  const inject = `${MARKER}<meta name="robots" content="noindex"><script>window.CEYLON_HOP_API=${JSON.stringify(STAGING_API)}</script>`;
  return html.slice(0, at) + inject + html.slice(at);
}

/** A nested checkout (a sibling worktree left in the tree) is never part of the site. */
function isNestedCheckout(dir) {
  return existsSync(path.join(dir, '.git'));
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    const src = path.join(from, entry);
    const dest = path.join(to, entry);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (from === ROOT && SKIP_DIRS.has(entry)) continue;
      if (isNestedCheckout(src)) continue;
      copyTree(src, dest);
    } else if (st.isFile()) {
      if (from === ROOT && (SKIP_FILES.has(entry) || entry.endsWith('.md'))) continue;
      if (entry.endsWith('.html')) writeFileSync(dest, stampHtml(readFileSync(src, 'utf8')));
      else copyFileSync(src, dest);
    }
  }
}

export function buildStaging(dest) {
  const out = path.resolve(dest);
  if (out === ROOT) throw new Error('build-staging: refusing to write over the repo');
  rmSync(out, { recursive: true, force: true });
  copyTree(ROOT, out);
  writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildStaging(process.argv[2] || path.join(ROOT, '.dist-staging'));
  console.log(`build-staging: wrote ${out} pointed at ${STAGING_API}`);
}
