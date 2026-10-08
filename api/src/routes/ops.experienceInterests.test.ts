import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo, type ExperienceInterestRepo } from '../db/experienceInterestRepo';
import { signSession } from '../lib/opsAuth';

const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
const COOKIE = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const EXP = {
  slug: 'ayurveda-massage', name: 'Ayurvedic massage', partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
  summary: 'A massage', details: '', priceCents: 3500, priceUnit: 'per_person' as const, durationText: null,
  openWeekdays: [], startTimes: [], lat: 7.977, lng: 80.76, radiusKm: 5, photos: [], partnerContact: null, active: true,
  createdBy: 'seed',
};

async function setup(interestsOverride?: ExperienceInterestRepo) {
  const bookings = new InMemoryBookingRepo();
  const experiences = new InMemoryExperienceRepo();
  const interests = new InMemoryExperienceInterestRepo({ bookings, experiences });
  const app = createApp({ bookings, auth: AUTH, adminApiKey: 'k', experiences, experienceInterests: interestsOverride ?? interests });
  const b = await bookings.create({
    mode: 'single', total: 5000, amountDueNow: 5000, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Sigiriya', vehicleType: 'car', adults: 2, children: 0, bags: 2,
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600000000', country: 'Spain' } },
  } as never);
  const e = await experiences.create(EXP as never);
  const get = () => app.request(`/admin/ops/bookings/${b.id}`, { headers: { cookie: COOKIE } });
  return { b, e, interests, get };
}

describe('GET /admin/ops/bookings/:id — experienceInterests', () => {
  it('is [] when the booking has none', async () => {
    const { get } = await setup();
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).experienceInterests).toEqual([]);
  });

  it('lists each interest with the experience name and area', async () => {
    const { b, e, interests, get } = await setup();
    const i = await interests.record({ experience: e, source: 'booking_page', bookingId: b.id });
    const { experienceInterests } = await (await get()).json();
    expect(experienceInterests).toEqual([{
      id: i.id, experienceName: 'Ayurvedic massage', areaLabel: 'Sigiriya', nameSnapshot: 'Ayurvedic massage',
      priceCentsSnapshot: 3500, priceUnitSnapshot: 'per_person', status: 'new', paymentRef: null,
      amountPaidCents: null, amountPaidCurrency: null, opsNote: null,
      scheduledDate: null, scheduledTime: null, meetingPoint: null, confirmationSentAt: null,
    }]);
  });

  it('carries the schedule and when the confirmation went (D21)', async () => {
    const { b, e, interests, get } = await setup();
    const i = await interests.record({ experience: e, source: 'booking_page', bookingId: b.id });
    await interests.patch(i.id, { status: 'paid', paymentRef: 'PH-1', scheduledDate: '2026-11-21', scheduledTime: '09:30', meetingPoint: 'Hotel lobby', updatedBy: 'o@x.com' });
    await interests.markConfirmationSent(i.id, new Date('2026-10-07T04:15:00.000Z'));
    const { experienceInterests } = await (await get()).json();
    expect(experienceInterests[0]).toMatchObject({
      scheduledDate: '2026-11-21', scheduledTime: '09:30', meetingPoint: 'Hotel lobby', confirmationSentAt: '2026-10-07T04:15:00.000Z',
    });
  });

  it('never fails the sheet when the lookup throws', async () => {
    const broken = { listForBooking: async () => { throw new Error('db down'); } } as unknown as ExperienceInterestRepo;
    const { get } = await setup(broken);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).experienceInterests).toEqual([]);
  });
});
