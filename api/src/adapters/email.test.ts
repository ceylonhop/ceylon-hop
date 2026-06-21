import { describe, it, expect, afterEach } from 'vitest';
import { FakeEmailAdapter, ResendEmailAdapter } from './email';

describe('FakeEmailAdapter', () => {
  it('records each sent message', async () => {
    const email = new FakeEmailAdapter();
    await email.send({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('a@b.com');
  });
});

describe('ResendEmailAdapter', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  it('POSTs the message to the Resend API with auth + correct body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    }) as unknown as typeof fetch;

    const email = new ResendEmailAdapter('re_test_key', {
      from: 'Ceylon Hop <hello@ceylonhop.com>',
      replyTo: 'ops@ceylonhop.com',
    });
    await email.send({ to: 'guest@example.com', subject: 'Your trip', html: '<p>Booked</p>', text: 'Booked' });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://api.resend.com/emails');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer re_test_key');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.from).toBe('Ceylon Hop <hello@ceylonhop.com>');
    expect(body.to).toEqual(['guest@example.com']);
    expect(body.subject).toBe('Your trip');
    expect(body.html).toBe('<p>Booked</p>');
    expect(body.text).toBe('Booked');
    expect(body.reply_to).toBe('ops@ceylonhop.com');
  });

  it('throws when the provider returns an error (so failures surface)', async () => {
    global.fetch = (async () => new Response('{"message":"bad"}', { status: 422 })) as typeof fetch;
    const email = new ResendEmailAdapter('re_test_key', { from: 'x@y.com' });
    await expect(
      email.send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' }),
    ).rejects.toThrow(/resend_send_failed_422/);
  });

  it('throws on a network failure', async () => {
    global.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    const email = new ResendEmailAdapter('k', { from: 'x@y.com' });
    await expect(email.send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })).rejects.toThrow();
  });

  it('omits text and reply_to when not provided', async () => {
    let body: Record<string, unknown> = {};
    global.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const email = new ResendEmailAdapter('k', { from: 'x@y.com' });
    await email.send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' });
    expect(body.text).toBeUndefined();
    expect(body.reply_to).toBeUndefined();
  });
});
