import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const KEY = 'secret-key';
const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function book(app: ReturnType<typeof createApp>) {
  const res = await app.request('/bookings/single', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(valid),
  });
  return res.json();
}

describe('GET /admin/bookings', () => {
  it('401 without a key', async () => {
    const app = createApp({ adminApiKey: KEY });
    expect((await app.request('/admin/bookings')).status).toBe(401);
  });

  it('401 with a wrong key', async () => {
    const app = createApp({ adminApiKey: KEY });
    const res = await app.request('/admin/bookings', { headers: { 'x-admin-key': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('lists bookings with the key', async () => {
    const app = createApp({ adminApiKey: KEY });
    await book(app);
    const res = await app.request('/admin/bookings', { headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
  });
});
