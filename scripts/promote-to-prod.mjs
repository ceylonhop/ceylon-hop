#!/usr/bin/env node
// The production gate. `main` auto-deploys to STAGING only; production deploys from the
// `production` branch, and this script is the ONLY sanctioned way to move it. It refuses to
// promote a commit whose CI ("ci" workflow) is not green — so nothing reaches real customers
// that did not pass on staging first (guard G4). After it moves `production`, Render's prod
// service auto-deploys, applies pending migrations on boot (fail-closed), and you run the
// post-deploy smoke against the prod URL.
//
//   node scripts/promote-to-prod.mjs                 # promote origin/main HEAD → production
//   node scripts/promote-to-prod.mjs <ref>           # promote a specific commit/branch/tag
//   node scripts/promote-to-prod.mjs --dry-run       # show what would happen, change nothing
//   node scripts/promote-to-prod.mjs --force         # skip the CI-green check (emergency only)
//   node scripts/promote-to-prod.mjs --rollback <ref># move production BACK to an earlier commit
//
// Requires: git, and the GitHub CLI `gh` authenticated (for the CI status check).
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const DRY = has('--dry-run');
const FORCE = has('--force');
const ROLLBACK = has('--rollback');
const positional = args.filter((a) => !a.startsWith('--'));

function sh(cmd, { capture = true } = {}) {
  return execSync(cmd, { stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
    ?.trim();
}
function trySh(cmd) {
  try {
    return sh(cmd);
  } catch {
    return null;
  }
}
function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// --- preflight ---------------------------------------------------------------
if (!trySh('git rev-parse --git-dir')) die('not inside a git repository.');
if (!trySh('gh --version')) die('the GitHub CLI `gh` is required (brew install gh; gh auth login).');

const remoteUrl = sh('git remote get-url origin');
const m = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
if (!m) die(`could not parse owner/repo from origin: ${remoteUrl}`);
const [owner, repo] = [m[1], m[2]];
const nwo = `${owner}/${repo}`;

console.log(`Repo: ${nwo}`);
sh('git fetch origin --tags --quiet');

// --- rollback path -----------------------------------------------------------
if (ROLLBACK) {
  const target = positional[0];
  if (!target) die('--rollback requires an explicit target, e.g. `--rollback <sha>` (a known-good earlier commit). Find one with: git log --first-parent origin/production');
  const sha = trySh(`git rev-parse ${target}^{commit}`);
  if (!sha) die(`cannot resolve ref: ${target}`);
  console.log(`\n⚠  ROLLBACK: production → ${sha.slice(0, 12)} (${target})`);
  console.log('   This moves production BACKWARDS. Render will redeploy prod to this commit.');
  if (DRY) {
    console.log('   [dry-run] would run: git push origin ' + sha + ':refs/heads/production --force-with-lease');
    process.exit(0);
  }
  sh(`git push origin ${sha}:refs/heads/production --force-with-lease`, { capture: false });
  console.log('\n✓ production moved. Watch the Render prod deploy, then smoke-test:');
  console.log('   node scripts/smoke-deploy.mjs <PROD_API_URL>');
  process.exit(0);
}

// --- resolve the commit to promote -------------------------------------------
const ref = positional[0] || 'origin/main';
const sha = trySh(`git rev-parse ${ref}^{commit}`);
if (!sha) die(`cannot resolve ref: ${ref}`);
const shortMsg = trySh(`git log -1 --format=%s ${sha}`) || '';
console.log(`\nCandidate: ${sha.slice(0, 12)}  "${shortMsg}"  (${ref})`);

// --- CI gate: the required workflow(s) must be green for this exact commit ----
// Gate on specific workflow files (robust) rather than "every check", so an unrelated or
// still-stabilizing check never blocks a real release. e2e.yml (the ops⇄quote Playwright suite)
// gates releases now that its requested_service drift is fixed and the full suite is green; if a
// run flakes, re-run it (retries:1 already absorbs the usual contention) or drop it back to
// ['ci.yml'] (see docs/staging-environment-runbook.md).
const REQUIRED_WORKFLOWS = ['ci.yml', 'e2e.yml'];
if (FORCE) {
  console.log('⚠  --force: skipping the CI-green check.');
} else {
  console.log(`Checking required workflows on this commit (${REQUIRED_WORKFLOWS.join(', ')})…`);
  for (const wf of REQUIRED_WORKFLOWS) {
    let runs;
    try {
      runs = JSON.parse(
        sh(`gh api "repos/${nwo}/actions/workflows/${wf}/runs?head_sha=${sha}&per_page=20" -q '[.workflow_runs[] | {status, conclusion, event}]'`),
      );
    } catch (e) {
      die(`could not read ${wf} status via gh (${String(e).split('\n')[0]}). Run \`gh auth login\`, or use --force if you verified CI another way.`);
    }
    if (!runs || runs.length === 0) {
      die(`no ${wf} run found for ${sha.slice(0, 12)} yet. Wait for CI to run on this commit (it runs on push to main), then retry.`);
    }
    const unfinished = runs.filter((r) => r.status !== 'completed');
    if (unfinished.length) die(`${wf} is still running for this commit. Retry once it finishes.`);
    // Require the latest completed run to be a success (a re-run that goes green counts).
    const latest = runs[0];
    if (latest.conclusion !== 'success') {
      die(`${wf} is NOT green for this commit (conclusion=${latest.conclusion}). Fix + re-merge before promoting.`);
    }
    console.log(`  ✓ ${wf} green`);
  }
}

// --- move production ----------------------------------------------------------
const prodTip = trySh('git rev-parse origin/production');
if (prodTip === sha) {
  console.log('\nproduction is already at this commit — nothing to promote.');
  process.exit(0);
}
if (prodTip) {
  // Only allow a forward (fast-forward) promotion; a non-ancestor means production has commits
  // main doesn't (a direct hotfix) — stop and let a human reconcile rather than force.
  const isAncestor = trySh(`git merge-base --is-ancestor ${prodTip} ${sha} && echo yes`);
  if (isAncestor !== 'yes') {
    die(`production (${prodTip.slice(0, 12)}) is not an ancestor of ${sha.slice(0, 12)} — it has commits main lacks. Reconcile manually (or use --rollback for an intentional move back).`);
  }
} else {
  console.log('production branch does not exist yet — this is the FIRST promotion; it will be created.');
}

if (DRY) {
  console.log(`\n[dry-run] would promote ${sha.slice(0, 12)} → production and tag it. Nothing changed.`);
  process.exit(0);
}

sh(`git push origin ${sha}:refs/heads/production`, { capture: false });
const tag = `release-${sha.slice(0, 12)}`;
trySh(`git tag -f ${tag} ${sha} && git push -f origin ${tag}`);

console.log(`\n✓ Promoted ${sha.slice(0, 12)} to production (tagged ${tag}).`);
console.log('  Render will now deploy prod (migrations apply on boot, fail-closed).');
console.log('  When the deploy finishes, smoke-test prod:');
console.log('     node scripts/smoke-deploy.mjs <PROD_API_URL>');
