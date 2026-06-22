import { describe, it, expect } from 'vitest';
import { InMemoryRideOpsRepo } from './rideOpsRepo';

describe('InMemoryRideOpsRepo', () => {
  it('lazily creates a ride_ops row at unassigned', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.getOrCreate('b1');
    expect(r.fulfilmentStatus).toBe('unassigned');
    expect(r.coordinatorId).toBeNull();
  });
  it('assigning a coordinator advances unassigned → assigned and stamps assignedAt', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.assign('b1', 'coord1');
    expect(r.coordinatorId).toBe('coord1');
    expect(r.fulfilmentStatus).toBe('assigned');
    expect(r.assignedAt).toBeTruthy();
  });
  it('setStatus enforces the transition guard and stamps timestamps', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.assign('b1', 'coord1');
    const sent = await repo.setStatus('b1', 'sent_to_coordinator');
    expect(sent.sentAt).toBeTruthy();
    await expect(repo.setStatus('b1', 'completed')).rejects.toThrow(); // illegal skip
  });
  it('setFlags toggles photo/customerUpdated/notes', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.setFlags('b1', { vehiclePhotoReceived: true, opsNotes: 'gate code 4421' });
    expect(r.vehiclePhotoReceived).toBe(true);
    expect(r.opsNotes).toBe('gate code 4421');
  });
  it('listByBookingIds returns existing rows only', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.getOrCreate('b1');
    expect((await repo.listByBookingIds(['b1', 'b2'])).map((r) => r.bookingId)).toEqual(['b1']);
  });
});
