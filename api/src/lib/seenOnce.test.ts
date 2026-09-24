import { describe, it, expect } from 'vitest';
import { SeenOnce } from './seenOnce';

// The pay-return attempt log's de-duplicator (review of #774, finding 2).
describe('SeenOnce', () => {
  it('says true the first time a key is seen, false while it is remembered', () => {
    const seen = new SeenOnce({ ttlMs: 1000, max: 10, now: () => 0 });
    expect(seen.first('a')).toBe(true);
    expect(seen.first('a')).toBe(false);
    expect(seen.first('b')).toBe(true);
  });

  it('forgets a key once its time-to-live has passed', () => {
    let t = 0;
    const seen = new SeenOnce({ ttlMs: 1000, max: 10, now: () => t });
    expect(seen.first('a')).toBe(true);
    t = 999;
    expect(seen.first('a')).toBe(false);
    t = 1000;
    expect(seen.first('a')).toBe(true);
  });

  it('never holds more than its cap, evicting the oldest first', () => {
    const seen = new SeenOnce({ ttlMs: 60_000, max: 2, now: () => 0 });
    seen.first('a');
    seen.first('b');
    seen.first('c'); // evicts 'a'
    expect(seen.size).toBe(2);
    expect(seen.first('b')).toBe(false);
    expect(seen.first('a')).toBe(true);
  });
});
