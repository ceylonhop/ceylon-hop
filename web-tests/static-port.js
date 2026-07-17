import { createHash } from 'node:crypto';

// Picks the port the e2e static server (serve-booking.js) listens on.
//
// It used to be a hardcoded 4173. Combined with reuseExistingServer:true that
// let a run silently reuse ANOTHER worktree's server — on 2026-07-17 a
// merge-verification run tested a stale ops-ui.html from a different tree and
// produced 9 phantom failures. So, absent an explicit CH_STATIC_PORT, each
// checkout derives its own stable port from its worktree path: parallel
// sessions land on different ports and can never share a server by accident.
//
// The 20000-29999 range stays clear of the project's fixed dev ports
// (4173 preview, 4180 home, 8787 API).
export function resolveStaticPort(env, worktreePath) {
  const explicit = Number.parseInt(env.CH_STATIC_PORT ?? '', 10);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const hash = createHash('sha256').update(worktreePath).digest();
  return 20000 + (hash.readUInt32BE(0) % 10000);
}
