import { describe, it, expect, vi, afterEach } from 'vitest';
import { logEvent } from './events';

// ────────────────────────────────────────────────────────────────────────────
//  Structured lifecycle events (2026-07-26).
//
//  The API logs 42 free-form console lines with no shape, so correlating a
//  Sentry error to "what was the ride board actually doing" is manual. This is
//  the smallest thing that fixes it: one JSON line per business event, greppable
//  by name, with no personal data in it.
// ────────────────────────────────────────────────────────────────────────────

afterEach(() => vi.restoreAllMocks());

function capture(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  fn();
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0][0] as string);
}

describe('logEvent', () => {
  it('emits one parseable JSON line', () => {
    const line = capture(() => logEvent('ride_board.join', { code: 'EM-1' }));
    expect(line.event).toBe('ride_board.join');
    expect(line.code).toBe('EM-1');
  });

  it('stamps every line so events can be ordered without the platform log', () => {
    const line = capture(() => logEvent('ride_board.join', {}));
    expect(typeof line.at).toBe('string');
    expect(Number.isNaN(Date.parse(line.at as string))).toBe(false);
  });

  it('carries arbitrary structured fields through unchanged', () => {
    const line = capture(() => logEvent('ride_board.cutoff', { confirmed: 2, expired: 1, processed: 3 }));
    expect(line).toMatchObject({ confirmed: 2, expired: 1, processed: 3 });
  });

  it('drops undefined fields rather than emitting nulls', () => {
    const line = capture(() => logEvent('x', { a: 1, b: undefined }));
    expect('b' in line).toBe(false);
  });

  it('never throws, whatever it is handed — telemetry must not break a request', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic; // JSON.stringify would throw
    expect(() => logEvent('ride_board.join', cyclic)).not.toThrow();
    spy.mockRestore();
  });

  it('survives a console that itself throws', () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('stdout gone'); });
    expect(() => logEvent('ride_board.join', { code: 'EM-1' })).not.toThrow();
  });
});
