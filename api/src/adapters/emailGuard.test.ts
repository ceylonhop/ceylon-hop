import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeEmailAdapter, wasDelivered } from './email';
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

// ── Audit 2026-09-22, finding 2 ────────────────────────────────────────────
// A suppressed message never reached anyone, but `send()` resolved exactly like a delivered
// one. The webhook could not tell the difference, so it wrote `markSent(...)` either way —
// and that ledger row is precisely what the paid-but-unconfirmed watchdog checks to decide
// nothing is wrong. Leaving NOTIFICATIONS_ENABLED off after an incident therefore stopped
// every customer's confirmation AND silenced the alarm built to catch exactly that.
describe('GuardedEmailAdapter — a caller can tell a suppressed send from a delivered one', () => {
  it('reports a delivered send', async () => {
    const inner = new FakeEmailAdapter();
    const out = await new GuardedEmailAdapter(inner, {}).send(msg('a@x.com'));
    expect(wasDelivered(out)).toBe(true);
    expect(inner.sent).toHaveLength(1);
  });

  it('reports a customer send suppressed by NOTIFICATIONS_ENABLED=false', async () => {
    const inner = new FakeEmailAdapter();
    const out = await new GuardedEmailAdapter(inner, { enabled: false }).send(msg('a@x.com'));
    expect(wasDelivered(out)).toBe(false);
    expect(inner.sent).toHaveLength(0);
  });

  it('reports a send suppressed by the allowlist', async () => {
    const inner = new FakeEmailAdapter();
    const guard = new GuardedEmailAdapter(inner, { allowlist: ['@ceylonhop.com'] });
    expect(wasDelivered(await guard.send(msg('stranger@example.com')))).toBe(false);
    expect(wasDelivered(await guard.send(msg('ops@ceylonhop.com')))).toBe(true);
  });

  // An ops alert must still get out while customer mail is switched off — that is the whole
  // point of the lever, and it is how the watchdog's own alert escapes.
  it('still delivers ops mail when customer mail is disabled', async () => {
    const inner = new FakeEmailAdapter();
    const guard = new GuardedEmailAdapter(inner, { enabled: false });
    expect(wasDelivered(await guard.send(msg('ops@x.com', { audience: 'ops' })))).toBe(true);
  });

  // A customer with no address is not a failure, it is a fact about the customer. It must be
  // distinguishable from a suppression so the watchdog can exempt it rather than page forever.
  it('reports a missing address as its own reason, not a suppression', async () => {
    const out = await new GuardedEmailAdapter(new FakeEmailAdapter(), {}).send(msg(''));
    expect(wasDelivered(out)).toBe(false);
    expect(out && 'reason' in out ? out.reason : null).toBe('no_address');
  });
});
