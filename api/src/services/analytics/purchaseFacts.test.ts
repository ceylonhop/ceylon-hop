import { describe, it, expect } from 'vitest';
import { purchaseFacts } from './purchaseFacts';

describe('purchaseFacts', () => {
  it('a hotel-to-town transfer reports known towns, regions, types and the route', () => {
    expect(purchaseFacts({
      service: 'transfer', stops: ['Granbell Hotel Colombo, Marine Drive, Colombo, Sri Lanka', 'Ella'],
      pax: 2, vehicle: 'car', date: '2026-11-08',
    })).toEqual({
      service_type: 'transfer',
      pickup: 'Colombo City', pickup_region: 'Colombo', pickup_type: 'address',
      dropoff: 'Ella', dropoff_region: 'Hill country', dropoff_type: 'town',
      route: 'Colombo City → Ella', region_route: 'Colombo → Hill country',
      pax: 2, vehicle_type: 'car', travel_date: '2026-11-08',
    });
  });
  it('a typed free-text end reads Other — never the text', () => {
    const f = purchaseFacts({ service: 'transfer', stops: ['my villa near the lighthouse', 'Galle'], pax: 1, vehicle: 'van3', date: null });
    expect(f).toMatchObject({ pickup: 'Other', pickup_type: 'unknown', route: 'Other → Galle', vehicle_type: 'van', travel_date: null });
  });
  it('a shared seat has no vehicle tier; an unrecorded leg is Other → Other', () => {
    expect(purchaseFacts({ service: 'shared_seat', stops: ['Pickup', 'Drop-off'], pax: 1, vehicle: null, date: '2026-11-01' }))
      .toMatchObject({ vehicle_type: 'shared', route: 'Other → Other' });
  });
  it('a date that is not YYYY-MM-DD is dropped, not guessed', () => {
    expect(purchaseFacts({ service: 'trip', stops: ['Kandy', 'Ella'], pax: null, vehicle: 'car', date: 'to confirm' }).travel_date).toBeNull();
  });
});
