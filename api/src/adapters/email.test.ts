import { describe, it, expect } from 'vitest';
import { FakeEmailAdapter } from './email';

describe('FakeEmailAdapter', () => {
  it('records each sent message', async () => {
    const email = new FakeEmailAdapter();
    await email.send({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('a@b.com');
  });
});
