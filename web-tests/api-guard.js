// Guards the CH_E2E_API suites against a foreign server on the API port.
//
// Playwright's webServer readiness probe only inspects the STATUS CODE, and it treats
// 400-403 as "ready". A squatter that 401s every path therefore looks like a healthy API;
// with reuseExistingServer:true Playwright then skips booting the real one and every spec
// fails with "#login not found". This asserts the server actually serves the ops shell.
//
// Kept as pure functions so the logic is unit-testable without a live server
// (unit/api-guard.test.js); global-setup.js does the fetching.

// Markers the CH_E2E_API specs depend on: the login overlay and the app shell root.
const SHELL_MARKERS = ['id="login"', 'id="approot"'];

// Returns null when the response is a real ops shell, or a short reason string when not.
export function opsShellProblem(status, body) {
  if (status !== 200) return `responded ${status}`;
  const missing = SHELL_MARKERS.filter((m) => !String(body ?? '').includes(m));
  if (missing.length) return `responded 200 but served no ops shell (missing ${missing.join(', ')})`;
  return null;
}

// Builds the failure text. It must name the port and the two ways out, because the
// symptom ("#login not found" x26) points nowhere near the actual cause.
export function guardMessage(base, problem) {
  return [
    `CH_E2E_API=1 but ${base}/ops is not the Ceylon Hop API — it ${problem}.`,
    '',
    'Something else is probably listening on that port. Playwright cannot tell:',
    'its readiness check accepts 401, so a squatter reads as "server ready" and the',
    'real API never boots — every ops/quote-tool spec then fails with "#login not found".',
    '',
    'Find the owner:   lsof -nP -iTCP:8787 -sTCP:LISTEN',
    'Then free the port, or point the suite elsewhere:',
    '  PORT=8799 npm --prefix ../api run dev',
    '  OPS_BASE=http://localhost:8799 CH_E2E_API=1 npx playwright test ops-ui',
  ].join('\n');
}
