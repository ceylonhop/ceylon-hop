import { describe, expect, it } from 'vitest';
import { FakeEmailAdapter, type EmailMessage } from './email';
import { GuardedEmailAdapter, type EmailPolicy } from './emailGuard';
import { ObservingEmailAdapter } from './observingEmail';
import { InMemoryCustomerCommunicationRepo } from '../db/customerCommunicationRepo';

const tracked = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: 'maya@example.com',
  subject: 'Your booking',
  html: '<p>Booked</p>',
  text: 'Booked',
  tracking: {
    bookingId: '00000000-0000-4000-8000-000000000001',
    kind: 'confirmation',
    templateKey: 'booking-confirmation',
    templateVersion: '1',
    source: 'payment_webhook',
    actorType: 'provider',
    requestId: '00000000-0000-4000-8000-000000000002',
    trackingKey: 'booking:confirmation',
  },
  ...overrides,
});

describe('ObservingEmailAdapter', () => {
  it('passes excluded untracked email through without creating ledger rows', async () => {
    const raw = new FakeEmailAdapter();
    const ledger = new InMemoryCustomerCommunicationRepo();
    const email = new ObservingEmailAdapter(raw, ledger);

    await email.send({ to: 'ops@example.com', subject: 'Ops alert', html: '<p>Alert</p>' });

    expect(raw.sent).toHaveLength(1);
    expect(await ledger.listEvents()).toEqual([]);
  });

  it('never blocks the existing send when the observation store is unavailable', async () => {
    const raw = new FakeEmailAdapter();
    const ledger = new InMemoryCustomerCommunicationRepo();
    ledger.plan = async () => { throw new Error('ledger offline'); };
    const email = new ObservingEmailAdapter(raw, ledger);

    await expect(email.send(tracked())).resolves.toMatchObject({ delivered: true });
    expect(raw.sent).toHaveLength(1);
  });

  it('records planned, attempted and provider acceptance without adding a second send', async () => {
    const raw = new FakeEmailAdapter();
    const ledger = new InMemoryCustomerCommunicationRepo();
    const email = new ObservingEmailAdapter(new GuardedEmailAdapter(raw, {}), ledger);

    const outcome = await email.send(tracked());

    expect(raw.sent).toHaveLength(1);
    expect(outcome).toMatchObject({ delivered: true, provider: 'fake', providerMessageId: expect.any(String) });
    const [communication] = await ledger.listByBookingId('00000000-0000-4000-8000-000000000001');
    expect(communication).toMatchObject({
      kind: 'confirmation', recipient: 'maya@example.com', provider: 'fake',
      providerMessageId: outcome && 'providerMessageId' in outcome ? outcome.providerMessageId : null,
    });
    expect((await ledger.listEvents(communication.id)).map((event) => event.eventType))
      .toEqual(['planned', 'send_attempted', 'provider_accepted']);
  });

  it.each([
    ['no address', tracked({ to: '' }), {}, 'no_address'],
    ['kill switch', tracked(), { enabled: false }, 'suppressed_disabled'],
    ['allowlist', tracked(), { allowlist: ['@ceylonhop.com'] }, 'suppressed_allowlist'],
  ] as const)('records %s suppression and sends nothing', async (_label, message, policy, reason) => {
    const raw = new FakeEmailAdapter();
    const ledger = new InMemoryCustomerCommunicationRepo();
    const normalizedPolicy: EmailPolicy = {
      enabled: 'enabled' in policy ? policy.enabled : undefined,
      allowlist: 'allowlist' in policy ? [...policy.allowlist] : undefined,
    };
    const email = new ObservingEmailAdapter(new GuardedEmailAdapter(raw, normalizedPolicy), ledger);

    expect(await email.send(message)).toEqual({ delivered: false, reason });
    expect(raw.sent).toHaveLength(0);
    const [communication] = await ledger.listByBookingId(message.tracking!.bookingId);
    expect((await ledger.listEvents(communication.id)).map((event) => [event.eventType, event.reasonCode]))
      .toEqual([['planned', null], ['suppressed', reason]]);
  });

  it.each(['provider 500', 'provider timeout'])(
    'records a sanitized failure and preserves the adapter error for %s',
    async (message) => {
      const raw = { send: async () => { throw new Error(message); } };
      const ledger = new InMemoryCustomerCommunicationRepo();
      const email = new ObservingEmailAdapter(new GuardedEmailAdapter(raw, {}), ledger);

      await expect(email.send(tracked())).rejects.toThrow(message);
      const [communication] = await ledger.listByBookingId('00000000-0000-4000-8000-000000000001');
      const events = await ledger.listEvents(communication.id);
      expect(events.map((event) => event.eventType)).toEqual(['planned', 'send_attempted', 'send_failed']);
      expect(events.at(-1)).toMatchObject({ reasonCode: 'provider_error', detailJson: null });
    },
  );

  it('does not persist message bodies or customer-action URLs', async () => {
    const ledger = new InMemoryCustomerCommunicationRepo();
    const email = new ObservingEmailAdapter(new FakeEmailAdapter(), ledger);
    await email.send(tracked({
      html: '<a href="https://example.com/manage?token=secret-token">Manage</a>',
      text: 'secret-token',
    }));

    const dump = JSON.stringify({
      communications: await ledger.listByBookingId('00000000-0000-4000-8000-000000000001'),
      events: await ledger.listEvents(),
    });
    expect(dump).not.toContain('secret-token');
    expect(dump).not.toContain('https://example.com/manage');
  });
});
