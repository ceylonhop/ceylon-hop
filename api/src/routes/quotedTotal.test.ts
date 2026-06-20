import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const customer = {
  firstName: 'Maya',
  lastName: 'Silva',
  email: 'maya@example.com',
  whatsapp: '+34600000000',
  country: 'Spain',
};
const single = { from: 'A', to: 'B', vehicleType: 'car', adults: 1, children: 0, bags: 0, customer };

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('quoted-total passthrough (price the customer agreed to)', () => {
  it('records the quoted total the site showed, not the server stub', async () => {
    const r = await post(createApp(), '/bookings/single', { ...single, quotedTotal: 7000 });
    expect(r.status).toBe(201);
    expect((await r.json()).total).toBe(7000);
  });

  it('falls back to the server quote when no quoted total is sent', async () => {
    const r = await post(createApp(), '/bookings/single', single);
    expect((await r.json()).total).toBe(4000); // stub: 1 adult, car
  });

  it('rejects an out-of-bounds quoted total (tampering guard)', async () => {
    const r = await post(createApp(), '/bookings/single', { ...single, quotedTotal: 5 }); // < $1
    expect(r.status).toBe(400);
  });

  it('applies to shared seats too', async () => {
    const r = await post(createApp(), '/bookings/shared', {
      corridorId: 'hill-line',
      date: '2026-07-20',
      time: '08:00',
      seats: 2,
      quotedTotal: 9000,
      customer,
    });
    expect(r.status).toBe(201);
    expect((await r.json()).total).toBe(9000); // not 2 × $21 = 4200
  });
});
