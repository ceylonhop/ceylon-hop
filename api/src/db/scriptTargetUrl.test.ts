// Guards the operational scripts (backfill-booking-legs.ts, check-booking-legs.ts) against the
// failure mode that leaked a production database password to a terminal: a bare value handed
// straight to the `postgres` driver throws `TypeError: Invalid URL` with the value verbatim in
// its `input` field, and Node prints that in full. requireConnectionUrl rejects anything that
// doesn't look like a connection string BEFORE it reaches the driver, and never echoes it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireConnectionUrl, redactConnectionString } from '../../scripts/lib/targetUrl';

const ENV_VAR = 'BACKFILL_DATABASE_URL';
// A distinctive fake secret — if this string shows up in any assertion failure output, that IS
// the bug, so it must be recognisable rather than something generic like "secret".
const FAKE_SECRET = 'hunter2-correct-horse-battery-staple';

describe('requireConnectionUrl', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  it('throws when the variable is not set at all', () => {
    expect(() => requireConnectionUrl(ENV_VAR, 'write to')).toThrow(
      /Set BACKFILL_DATABASE_URL to the database you mean to write to/,
    );
  });

  it('rejects a bare password and never echoes it', () => {
    process.env[ENV_VAR] = FAKE_SECRET;
    let thrown: unknown;
    try {
      requireConnectionUrl(ENV_VAR, 'write to');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(FAKE_SECRET);
    // The whole point of this guard: tell the operator to rotate the credential, because it may
    // now be sitting in their shell history in the clear.
    expect(message).toMatch(/rotate/i);
  });

  it('rejects a value with the wrong scheme and never echoes it', () => {
    const wrongScheme = `mysql://user:${FAKE_SECRET}@localhost:3306/db`;
    process.env[ENV_VAR] = wrongScheme;
    let thrown: unknown;
    try {
      requireConnectionUrl(ENV_VAR, 'read');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(wrongScheme);
    expect(message).not.toContain(FAKE_SECRET);
  });

  it('accepts a well-formed postgres:// URL', () => {
    const url = `postgres://user:${FAKE_SECRET}@localhost:5432/db`;
    process.env[ENV_VAR] = url;
    expect(requireConnectionUrl(ENV_VAR, 'write to')).toBe(url);
  });

  it('accepts a well-formed postgresql:// URL', () => {
    const url = `postgresql://user:${FAKE_SECRET}@localhost:5432/db`;
    process.env[ENV_VAR] = url;
    expect(requireConnectionUrl(ENV_VAR, 'read')).toBe(url);
  });
});

describe('redactConnectionString', () => {
  it('strips a literal occurrence of the connection string from arbitrary text', () => {
    const url = `postgres://user:${FAKE_SECRET}@localhost:5432/db`;
    const message = `connection failed: ${url} is unreachable`;
    const safe = redactConnectionString(message, url);
    expect(safe).not.toContain(FAKE_SECRET);
    expect(safe).not.toContain(url);
  });

  it('strips just the password when only the password appears in the text', () => {
    const url = `postgres://user:${FAKE_SECRET}@localhost:5432/db`;
    const message = `password authentication failed for "${FAKE_SECRET}"`;
    const safe = redactConnectionString(message, url);
    expect(safe).not.toContain(FAKE_SECRET);
  });

  it('leaves unrelated text untouched', () => {
    const url = `postgres://user:${FAKE_SECRET}@localhost:5432/db`;
    const message = 'relation "bookings" does not exist';
    expect(redactConnectionString(message, url)).toBe(message);
  });
});
