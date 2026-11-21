// Per-leg ops steps (spec 2026-11-19): one fulfilment row per driven leg, keyed by booking_legs.id.
// Exported so postgres.test.ts runs the SAME cases against Postgres: the two repos must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryRideOpsLegRepo, type RideOpsLegRepo } from './rideOpsLegRepo';

export interface RideOpsLegHarness {
  repo: RideOpsLegRepo;
  /** Ids of three legs of one trip that the repo may write against. */
  legIds: [string, string, string];
}

export function rideOpsLegRepoContract(name: string, make: () => Promise<RideOpsLegHarness>): void {
  describe(name, () => {
    it('a leg nobody has touched has no row', async () => {
      const { repo, legIds } = await make();
      expect(await repo.get(legIds[0])).toBeNull();
      expect(await repo.listByLegIds(legIds)).toEqual([]);
    });

    it('walks one leg through the full path and stamps vehicleConfirmedAt', async () => {
      const { repo, legIds: [leg] } = await make();
      const veh = await repo.setStatus(leg, 'vehicle_confirmed');
      expect(veh.vehicleConfirmedAt).toBeTruthy();
      await repo.setStatus(leg, 'pickup_confirmed');
      await repo.setStatus(leg, 'on_trip');
      const done = await repo.setStatus(leg, 'completed');
      expect(done).toMatchObject({ legId: leg, fulfilmentStatus: 'completed' });
    });

    it('completing one leg leaves the other legs where they were', async () => {
      const { repo, legIds: [first, second, third] } = await make();
      for (const to of ['vehicle_confirmed', 'pickup_confirmed', 'on_trip', 'completed'] as const) await repo.setStatus(first, to);
      await repo.setStatus(second, 'vehicle_confirmed');
      const rows = await repo.listByLegIds([first, second, third]);
      expect(Object.fromEntries(rows.map((r) => [r.legId, r.fulfilmentStatus]))).toEqual({
        [first]: 'completed', [second]: 'vehicle_confirmed',
      });
    });

    it('refuses an illegal skip, starting from paid', async () => {
      const { repo, legIds: [leg] } = await make();
      await expect(repo.setStatus(leg, 'completed')).rejects.toThrow();
      expect(await repo.get(leg)).toBeNull();
    });

    it('allows the single-step backtrack and the idempotent re-set', async () => {
      const { repo, legIds: [leg] } = await make();
      await repo.setStatus(leg, 'vehicle_confirmed');
      expect((await repo.setStatus(leg, 'vehicle_confirmed')).fulfilmentStatus).toBe('vehicle_confirmed');
      expect((await repo.setStatus(leg, 'paid')).fulfilmentStatus).toBe('paid');
    });

    it('refuses no_show: a no-show closes the whole booking, not one leg', async () => {
      const { repo, legIds: [leg] } = await make();
      await expect(repo.setStatus(leg, 'no_show' as never)).rejects.toThrow();
    });

    it('sets the ticks per leg without moving the status', async () => {
      const { repo, legIds: [first, second] } = await make();
      const r = await repo.setFlags(first, { vehiclePhotoReceived: true });
      expect(r).toMatchObject({ vehiclePhotoReceived: true, customerUpdated: false, fulfilmentStatus: 'paid' });
      const again = await repo.setFlags(first, { customerUpdated: true });
      expect(again).toMatchObject({ vehiclePhotoReceived: true, customerUpdated: true });
      expect(await repo.get(second)).toBeNull();
    });
  });
}

rideOpsLegRepoContract('InMemoryRideOpsLegRepo', async () => ({
  repo: new InMemoryRideOpsLegRepo(),
  legIds: [randomUUID(), randomUUID(), randomUUID()],
}));
