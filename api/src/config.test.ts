import { describe, it, expect } from 'vitest';
import { buildConfig } from './config';

// The founder ops-session cookie now unlocks /admin/quote (margin + customer PII), so a
// defaulted/empty OPS_SESSION_SECRET in production is a founder-forgery hole: anyone who
// reads the public repo can mint a valid founder cookie. Production must FAIL CLOSED at
// boot; dev/test keep the convenience default.
describe('config — OPS_SESSION_SECRET fails closed in production', () => {
  it('throws in production when OPS_SESSION_SECRET is unset (falls back to the dev default)', () => {
    expect(() => buildConfig({ NODE_ENV: 'production' })).toThrow(/OPS_SESSION_SECRET/);
  });

  it('throws in production when OPS_SESSION_SECRET is explicitly the dev default', () => {
    expect(() =>
      buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: 'dev-ops-secret-change-me' }),
    ).toThrow(/OPS_SESSION_SECRET/);
  });

  it('throws in production when OPS_SESSION_SECRET is empty', () => {
    expect(() => buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: '' })).toThrow(
      /OPS_SESSION_SECRET/,
    );
  });

  it('boots in production with a real secret', () => {
    expect(() =>
      buildConfig({ NODE_ENV: 'production', OPS_SESSION_SECRET: 'a-real-32char-random-secret' }),
    ).not.toThrow();
  });

  it('tolerates the default secret outside production (dev/test)', () => {
    expect(buildConfig({ NODE_ENV: 'test' }).OPS_SESSION_SECRET).toBe('dev-ops-secret-change-me');
    expect(buildConfig({ NODE_ENV: 'development' }).OPS_SESSION_SECRET).toBe('dev-ops-secret-change-me');
  });
});
