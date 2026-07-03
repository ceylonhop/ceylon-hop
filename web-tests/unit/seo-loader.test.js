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
    // billable = round(136*1.10)=150; car=max(29,round(150*0.46))=69; van=max(50,round(150*0.83))=125
    expect(q.car).toBe(69);
    expect(q.van).toBe(125);
  });
  it('finds a shared corridor where one exists', () => {
    expect(T.sharedOption('kandy', 'ella')).toBeTruthy();      // hill-line
    expect(T.sharedOption('cmb-airport', 'galle')).toBeNull(); // no shared corridor
  });
});
