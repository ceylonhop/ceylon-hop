import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { initTracking, track, _isEnabledForTests, _resetForTests } from './track';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(() => 'event-id'),
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setTag: vi.fn(), setExtras: vi.fn() }),
  ),
}));

const mocked = vi.mocked(Sentry);

describe('track (Sentry seam)', () => {
  afterEach(() => {
    _resetForTests();
    vi.clearAllMocks();
  });

  it('is a no-op before init and never throws', () => {
    expect(() => track(new Error('boom'))).not.toThrow();
    expect(_isEnabledForTests()).toBe(false);
    expect(mocked.captureException).not.toHaveBeenCalled();
  });

  it('stays dormant when initTracking gets no DSN (launch keys not set yet)', () => {
    initTracking(undefined, { environment: 'test' });
    expect(mocked.init).not.toHaveBeenCalled();
    expect(_isEnabledForTests()).toBe(false);
    track(new Error('boom'));
    expect(mocked.captureException).not.toHaveBeenCalled();
  });

  it('initialises the SDK and captures exceptions once a DSN is set', () => {
    initTracking('https://key@o0.ingest.sentry.io/0', { environment: 'test', release: 'abc123' });
    expect(mocked.init).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'test', release: 'abc123', tracesSampleRate: 0 }),
    );
    expect(_isEnabledForTests()).toBe(true);
    track(new Error('boom'), { route: '/bookings', tag: 'frontend' });
    expect(mocked.captureException).toHaveBeenCalledTimes(1);
  });

  it('wraps non-Error values so Sentry still gets a stack', () => {
    initTracking('https://key@o0.ingest.sentry.io/0', { environment: 'test' });
    track('string failure');
    expect(mocked.captureException.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
