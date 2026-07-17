import { opsShellProblem, guardMessage } from './api-guard.js';

// Runs once before the suites, AFTER Playwright has started/reused the webServers
// (verified against Playwright 1.61: globalSetup can reach the webServer).
//
// Only guards the opt-in CH_E2E_API run — the default offline suite never touches the API.
export default async function globalSetup() {
  if (process.env.CH_E2E_API !== '1') return;

  const base = process.env.OPS_BASE || 'http://localhost:8787';

  let status;
  let body;
  try {
    const res = await fetch(`${base}/ops`);
    status = res.status;
    body = await res.text();
  } catch (err) {
    throw new Error(guardMessage(base, `is unreachable (${err.message})`));
  }

  const problem = opsShellProblem(status, body);
  if (problem) throw new Error(guardMessage(base, problem));
}
