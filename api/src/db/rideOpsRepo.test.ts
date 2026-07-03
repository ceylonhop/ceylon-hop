import { describe, it, expect } from 'vitest';
import { InMemoryRideOpsRepo } from './rideOpsRepo';

describe('InMemoryRideOpsRepo', () => {
  it('lazily creates a ride_ops row at paid', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.getOrCreate('b1');
    expect(r.fulfilmentStatus).toBe('paid');
  });

  it('setStatus enforces the transition guard and stamps vehicleConfirmedAt', async () => {
    const repo = new InMemoryRideOpsRepo();
    const veh = await repo.setStatus('b1', 'vehicle_confirmed');
    expect(veh.vehicleConfirmedAt).toBeTruthy();
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

  it('walks the full fulfilment path and stamps vehicleConfirmedAt', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.getOrCreate('b1'); // → paid
    const veh = await repo.setStatus('b1', 'vehicle_confirmed');
    expect(veh.vehicleConfirmedAt).toBeTruthy();
    await repo.setStatus('b1', 'pickup_confirmed');
    await repo.setStatus('b1', 'on_trip');
    const done = await repo.setStatus('b1', 'completed');
    expect(done.fulfilmentStatus).toBe('completed');
  });

  it('toggles customerUpdated independently of status', async () => {
    const repo = new InMemoryRideOpsRepo();
    const r = await repo.setFlags('b1', { customerUpdated: true });
    expect(r.customerUpdated).toBe(true);
    expect(r.fulfilmentStatus).toBe('paid'); // flag does not move status
  });

  it('is idempotent on setting the same status', async () => {
    const repo = new InMemoryRideOpsRepo();
    const a = await repo.setStatus('b1', 'paid'); // same → allowed, no throw
    expect(a.fulfilmentStatus).toBe('paid');
  });

  it('allows a single-step backtrack from vehicle_confirmed to paid', async () => {
    const repo = new InMemoryRideOpsRepo();
    await repo.setStatus('b1', 'vehicle_confirmed');
    const back = await repo.setStatus('b1', 'paid');
    expect(back.fulfilmentStatus).toBe('paid');
  });
});
