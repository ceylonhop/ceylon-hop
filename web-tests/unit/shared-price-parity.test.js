import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers, loadRoutes } from './_load.js';

// The catalogue (routes-data.js) carries a hardcoded `price` on each shared ride,
// but the quote engine prices shared seats from the corridor's flat seat price
// (transfers-data.js CORRIDORS, which itself mirrors the backend source of truth
// api/src/db/departureRepo.ts). These two drifted once (GL-4 synced the corridors
// but the frozen catalogue kept June prices) and customers saw different prices
// depending on entry path. This test locks them together so it can't recur.
let T, ROUTES;
beforeAll(() => { T = loadTransfers(); ROUTES = loadRoutes(); });

describe('shared-ride catalogue price == corridor seat price', () => {
  it('every type:shared route matches its corridor flat seat price', () => {
    const shared = ROUTES.filter((r) => r.type === 'shared');
    expect(shared.length).toBeGreaterThan(0);
    for (const r of shared) {
      // Resolve the first leg (stops[0] -> stops[1]) to place ids, then ask the
      // engine which corridor carries them and at what seat price.
      const fromId = T.resolvePlace(r.stops[0])?.id;
      const toId = T.resolvePlace(r.stops[1])?.id;
      const opt = fromId && toId ? T.sharedOption(fromId, toId) : null;
      expect(opt, `${r.id}: no corridor carries ${r.stops[0]}->${r.stops[1]}`).toBeTruthy();
      expect(r.price, `${r.id} catalogue price must equal corridor ${opt.corridorId} seat`).toBe(opt.seat);
    }
  });
});
