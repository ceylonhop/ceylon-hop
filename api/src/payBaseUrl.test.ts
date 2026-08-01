import { describe, it, expect, afterEach, vi } from 'vitest';

/* A customer-facing payment link was going out reading ops.<domain> (owner, 2026-07-31).
   The obvious fix — repoint APP_BASE_URL at the pay domain — is wrong: APP_BASE_URL also
   drives the site links in three emails and PayHere's return_url/cancel_url, so it would
   drag all of that onto the pay domain too. PAY_BASE_URL moves the pay/manage links ONLY,
   and falls back to the old behaviour when unset so setting nothing changes nothing. */

const ENV_KEYS = ['PAY_BASE_URL', 'APP_BASE_URL'];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function freshConfig() {
  // config.ts parses its schema at import time, so the module cache has to be dropped for the
  // env we just set to be seen. (A query-string cache-bust does not work here — Vite cannot
  // resolve a computed specifier.)
  vi.resetModules();
  const mod = await import('./config.js');
  return mod.config as unknown as Record<string, string>;
}

describe('PAY_BASE_URL', () => {
  it('is empty by default, so behaviour is unchanged until it is deliberately set', async () => {
    delete process.env.PAY_BASE_URL;
    const config = await freshConfig();
    expect(config.PAY_BASE_URL).toBe('');
  });

  it('is read independently of APP_BASE_URL', async () => {
    process.env.APP_BASE_URL = 'https://ceylonhop.com';
    process.env.PAY_BASE_URL = 'https://pay.ceylonhop.com';
    const config = await freshConfig();
    expect(config.PAY_BASE_URL).toBe('https://pay.ceylonhop.com');
    // The site origin is untouched — this is the whole point of the separate variable.
    expect(config.APP_BASE_URL).toBe('https://ceylonhop.com');
  });
});

describe('the pay origin resolves in the documented order', () => {
  // Mirrors app.ts: deps.payBaseUrl ?? (PAY_BASE_URL || undefined) ?? deps.bookingBaseUrl ?? APP_BASE_URL
  const resolve = (deps: { payBaseUrl?: string; bookingBaseUrl?: string }, cfg: { PAY_BASE_URL: string; APP_BASE_URL: string }) =>
    deps.payBaseUrl ?? (cfg.PAY_BASE_URL || undefined) ?? deps.bookingBaseUrl ?? cfg.APP_BASE_URL;

  const cfg = { PAY_BASE_URL: '', APP_BASE_URL: 'https://ceylonhop.com' };

  it('falls back to the customer site when no pay domain is configured', () => {
    expect(resolve({}, cfg)).toBe('https://ceylonhop.com');
  });

  it('uses the pay domain once it is set', () => {
    expect(resolve({}, { ...cfg, PAY_BASE_URL: 'https://pay.ceylonhop.com' })).toBe('https://pay.ceylonhop.com');
  });

  it('an explicit dep still wins, so tests and staging can override', () => {
    expect(resolve({ payBaseUrl: 'http://localhost:8787' }, { ...cfg, PAY_BASE_URL: 'https://pay.ceylonhop.com' }))
      .toBe('http://localhost:8787');
  });

  it('an empty PAY_BASE_URL never beats bookingBaseUrl — "" must not win as a value', () => {
    expect(resolve({ bookingBaseUrl: 'https://staging.example' }, cfg)).toBe('https://staging.example');
  });
});
