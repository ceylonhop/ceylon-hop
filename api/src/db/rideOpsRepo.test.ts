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

  it('walks the full fulfilment path and stamps each timestamp', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.assign('b1', 'coord1'); // → assigned
    await repo.setStatus('b1', 'sent_to_coordinator');
    const ack = await repo.setStatus('b1', 'acknowledged');
    expect(ack.acknowledgedAt).toBeTruthy();
    const veh = await repo.setStatus('b1', 'vehicle_confirmed');
    expect(veh.vehicleConfirmedAt).toBeTruthy();
    await repo.setStatus('b1', 'customer_updated');
    const done = await repo.setStatus('b1', 'completed');
    expect(done.fulfilmentStatus).toBe('completed');
  });

  it('un-assigning (coordinatorId null) resets to unassigned', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.assign('b1', 'coord1');
    const off = await repo.assign('b1', null);
    expect(off.coordinatorId).toBeNull();
    expect(off.fulfilmentStatus).toBe('unassigned');
  });

  it('toggles customerUpdated independently of status', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.setFlags('b1', { customerUpdated: true });
    expect(r.customerUpdated).toBe(true);
    expect(r.fulfilmentStatus).toBe('unassigned'); // flag does not move status
  });

  it('is idempotent on setting the same status', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.assign('b1', 'coord1');
    const a = await repo.setStatus('b1', 'assigned'); // same → allowed, no throw
    expect(a.fulfilmentStatus).toBe('assigned');
  });
});
