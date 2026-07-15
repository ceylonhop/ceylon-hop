import { describe, it, expect } from 'vitest';
import { loadTransfers } from '../../tools/load-transfers.mjs';

describe('loadTransfers', () => {
  const T = loadTransfers();
  it('exposes the TRANSFERS API', () => {
    expect(typeof T.privateQuote).toBe('function');
    expect(typeof T.sharedOption).toBe('function');
    expect(T.byId['kandy'].name).toBe('Kandy');
  });
  it('prices Kandy→Ella from the engine rate card', () => {
    const q = T.privateQuote('kandy', 'ella'); // real leg 136 km
    expect(q.km).toBe(136);
    // Core fares are $60/$81; final-price finishing produces $59/$79.
    expect(q.rawCar).toBe(60);
    expect(q.rawVan).toBe(81);
    expect(q.car).toBe(59);
    expect(q.van).toBe(79);
  });
  it('finds a shared corridor where one exists', () => {
    expect(T.sharedOption('kandy', 'ella')).toBeTruthy();      // hill-line
    expect(T.sharedOption('cmb-airport', 'galle')).toBeNull(); // no shared corridor
  });
});
