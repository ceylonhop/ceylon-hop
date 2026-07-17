import { describe, it, expect } from 'vitest';
import { opsShellProblem, guardMessage } from '../api-guard.js';

// The CH_E2E_API suites drive the ops shell served by the API at /ops. Playwright's
// webServer readiness check only looks at the STATUS CODE, and it accepts 400-403 as
// "ready" — so a foreign server squatting the port that 401s everything reads as a
// healthy API. Combined with reuseExistingServer:true, Playwright then never boots the
// real API and every spec fails with a baffling "#login not found".
//
// That actually happened (2026-07-17: a stale codex-relay process owned 8787 for ~10
// days), and it silently masked a real regression. opsShellProblem() is the content
// check the status code can't do.
describe('opsShellProblem', () => {
  const shell = '<html><body><div id="login"></div><div id="approot"></div></body></html>';

  it('passes a real ops shell', () => {
    expect(opsShellProblem(200, shell)).toBeNull();
  });

  it('rejects the 401 squatter that Playwright mistakes for a ready server', () => {
    const body = '{"error":{"code":"unauthorized","message":"Pair this device with the Codex Relay server."}}';
    const problem = opsShellProblem(401, body);
    expect(problem).toMatch(/401/);
  });

  it('rejects a 200 from something that is not the ops shell', () => {
    const problem = opsShellProblem(200, '<html><body>some other app</body></html>');
    expect(problem).toMatch(/shell/i);
  });

  it('rejects a partial shell (login overlay without the app root)', () => {
    expect(opsShellProblem(200, '<div id="login"></div>')).toMatch(/shell/i);
  });

  it('names the base URL and how to find the port owner, so the failure is actionable', () => {
    const msg = guardMessage('http://localhost:8787', 'responded 401');
    expect(msg).toContain('http://localhost:8787');
    expect(msg).toContain('responded 401');
    expect(msg).toContain('lsof'); // tells you how to identify the squatter
    expect(msg).toContain('OPS_BASE'); // tells you the escape hatch
  });
});
