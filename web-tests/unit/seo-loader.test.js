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
    // billable = 136 + round(13.6)=150; car=max(29,round(150*0.4025))=60; van=max(50,round(150*0.5405))=81
    expect(q.car).toBe(60);
    expect(q.van).toBe(81);
  });
  it('finds a shared corridor where one exists', () => {
    expect(T.sharedOption('kandy', 'ella')).toBeTruthy();      // hill-line
    expect(T.sharedOption('cmb-airport', 'galle')).toBeNull(); // no shared corridor
  });
});
