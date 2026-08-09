import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeEmailAdapter } from './email';
import { GuardedEmailAdapter, parseAllowlist, isAllowed } from './emailGuard';

const msg = (to: string, extra: Record<string, unknown> = {}) => ({
  to,
  subject: 'Your Ceylon Hop trip is coming up — CH-ABC12',
  html: '<p>hi</p>',
  text: 'hi',
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe('parseAllowlist', () => {
  it('splits, trims, lowercases, and drops empties', () => {
    expect(parseAllowlist(' Roshen@Ceylonhop.com , @ceylonhop.com ,, ')).toEqual([
      'roshen@ceylonhop.com',
      '@ceylonhop.com',
    ]);
  });

  it('treats an unset or blank value as no allowlist at all', () => {
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
});

describe('isAllowed', () => {
  it('matches an exact address, case-insensitively', () => {
    expect(isAllowed('Roshen@Ceylonhop.com', ['roshen@ceylonhop.com'])).toBe(true);
    expect(isAllowed('someone@gmail.com', ['roshen@ceylonhop.com'])).toBe(false);
  });

  it('matches a whole domain via an @suffix entry', () => {
    expect(isAllowed('anyone@ceylonhop.com', ['@ceylonhop.com'])).toBe(true);
    // A suffix must match the domain, not merely appear in the address.
    expect(isAllowed('ceylonhop.com@evil.com', ['@ceylonhop.com'])).toBe(false);
    expect(isAllowed('maya@notceylonhop.com', ['@ceylonhop.com'])).toBe(false);
  });

  it('allows everything when the list is empty', () => {
    expect(isAllowed('anyone@anywhere.com', [])).toBe(true);
  });
});

describe('GuardedEmailAdapter', () => {
  it('passes a normal message straight through', async () => {
    const inner = new FakeEmailAdapter();
    const guard = new GuardedEmailAdapter(inner, {});
    await guard.send(msg('maya@example.com'));
    expect(inner.sent).toHaveLength(1);
  });

  describe('allowlist', () => {
    it('drops a recipient outside the list and delivers one inside it', async () => {
      const inner = new FakeEmailAdapter();
      const guard = new GuardedEmailAdapter(inner, { allowlist: ['@ceylonhop.com'] });

      await guard.send(msg('maya@example.com')); // a real customer — must NOT be mailed
      await guard.send(msg('roshen@ceylonhop.com'));

      expect(inner.sent).toHaveLength(1);
      expect(inner.sent[0].to).toBe('roshen@ceylonhop.com');
    });

    it('applies to ops mail too — staging must not mail anyone outside the list', async () => {
      const inner = new FakeEmailAdapter();
      const guard = new GuardedEmailAdapter(inner, { allowlist: ['@ceylonhop.com'] });
      await guard.send(msg('someone@example.com', { audience: 'ops' }));
      expect(inner.sent).toHaveLength(0);
    });
  });

  describe('kill switch', () => {
    it('drops customer mail when notifications are disabled', async () => {
      const inner = new FakeEmailAdapter();
      const guard = new GuardedEmailAdapter(inner, { enabled: false });
      await guard.send(msg('maya@example.com'));
      expect(inner.sent).toHaveLength(0);
    });

    it('still delivers OPS mail when disabled — killing the alerts would blind us', async () => {
      const inner = new FakeEmailAdapter();
      const guard = new GuardedEmailAdapter(inner, { enabled: false });
      await guard.send(msg('alerts@ceylonhop.com', { audience: 'ops' }));
      expect(inner.sent).toHaveLength(1);
    });
  });

  it('short-circuits a blank address without consulting either rule', async () => {
    const inner = new FakeEmailAdapter();
    const guard = new GuardedEmailAdapter(inner, { allowlist: ['@ceylonhop.com'] });
    await guard.send(msg(''));
    expect(inner.sent).toHaveLength(0);
  });

  it('records every drop as an event carrying the DOMAIN only, never the address', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const guard = new GuardedEmailAdapter(new FakeEmailAdapter(), { allowlist: ['@ceylonhop.com'] });

    await guard.send(msg('maya@example.com'));

    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('notification.suppressed'));
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({ event: 'notification.suppressed', reason: 'allowlist', audience: 'customer' });
    expect(event.toDomain).toBe('example.com');
    // events.ts is contractually free of personal data — the local part must not leak.
    expect(lines[0]).not.toContain('maya');
  });

  it('is a no-op wrapper when neither rule is configured', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const inner = new FakeEmailAdapter();
    const guard = new GuardedEmailAdapter(inner, { enabled: true, allowlist: [] });
    await guard.send(msg('anyone@anywhere.com'));
    expect(inner.sent).toHaveLength(1);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('notification.suppressed'))).toHaveLength(0);
  });
});
