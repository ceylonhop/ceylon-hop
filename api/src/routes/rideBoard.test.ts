import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-08-08', slot: 'morning',
  minSeats: 4, capacity: 6, seatPrice: 2400, note: 'surfboards welcome', cutoffAt: new Date('2026-08-06T01:30:00Z'),
  createdBy: 'creator', ...over,
});

async function seededApp() {
  const rideLists = new InMemoryRideListRepo();
  const a = await rideLists.createList(listArgs());
  await rideLists.addMember(a.id, { sub: 'lea-sub', firstName: 'Léa', country: 'FR', email: 'lea@secret.com', seats: 1, photoUrl: 'https://photo/lea' });
  await rideLists.addMember(a.id, { sub: 'tom-sub', firstName: 'Tom', country: 'GB', email: 'tom@secret.com', seats: 1 });
  const b = await rideLists.createList(listArgs({ fromPlace: 'Kandy', toPlace: 'Ella', corridorId: 'hill-line', seatPrice: 2100 }));
  await rideLists.addMember(b.id, { sub: 'mia-sub', firstName: 'Mia', country: 'DE', email: 'mia@secret.com', seats: 1 });
  return { app: createApp({ rideLists }), codeA: a.code, codeB: b.code };
}

describe('GET /board', () => {
  it('returns open lists with public projections', async () => {
    const { app } = await seededApp();
    const res = await app.request('/board');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lists).toHaveLength(2);
    const ella = body.lists.find((l: { from: string }) => l.from === 'Ella');
    expect(ella.committed).toBe(2);
    expect(ella.members.map((m: { firstName: string }) => m.firstName)).toEqual(['Léa', 'Tom']);
    expect(ella.members[0].isStarter).toBe(true);
    expect(ella.note).toBe('surfboards welcome');
  });

  it('never leaks email or subject in the projection', async () => {
    const { app } = await seededApp();
    const body = await (await app.request('/board')).json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('secret.com');
    expect(raw).not.toContain('lea-sub');
    expect(raw).not.toContain('preapproval');
  });

  it('filters by from-city', async () => {
    const { app } = await seededApp();
    const body = await (await app.request('/board?from=Kandy')).json();
    expect(body.lists).toHaveLength(1);
    expect(body.lists[0].from).toBe('Kandy');
  });
});

describe('GET /board/:code', () => {
  it('returns one list by code', async () => {
    const { app, codeA } = await seededApp();
    const res = await app.request(`/board/${codeA}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(codeA);
    expect(body.to).toBe('Mirissa');
    expect(body.seatPrice).toBe(2400);
  });

  it('404s an unknown code', async () => {
    const { app } = await seededApp();
    const res = await app.request('/board/NOPE-0000');
    expect(res.status).toBe(404);
  });
});
