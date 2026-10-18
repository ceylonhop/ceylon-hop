import { describe, it, expect } from 'vitest';
import { refreshExperiencePins } from './pinRefresh';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { FakeBusinessPlaces, type BusinessDetails } from '../adapters/businessPlaces';
import { ExperienceInputSchema } from './experience';

// Google lets us keep Places lat/lng for at most 30 days (Service Specific Terms §14.3) and place ids
// indefinitely, so every experience filled from Google gets its pin re-fetched by place id each day.
const ID = 'ChIJAtherya0000000000000';
const place = (lat: number, lng: number): BusinessDetails => ({
  placeId: ID, name: 'Athreya', address: '', lat, lng, area: null, phone: null, website: null, mapsUrl: null, openWeekdays: null,
});
const input = (slug: string, over: Record<string, unknown> = {}) => ExperienceInputSchema.parse({
  slug, name: 'Massage', partnerName: 'Athreya', areaLabel: 'Sigiriya', summary: 's', priceCents: 3500, priceUnit: 'per_person',
  openWeekdays: [1], startTimes: [], lat: 7.95, lng: 80.76, ...over,
});

describe('refreshExperiencePins', () => {
  it('re-fetches every Google-sourced pin, moves the ones Google moved, and leaves the rest alone', async () => {
    const experiences = new InMemoryExperienceRepo();
    const moved = await experiences.create(input('moved', { googlePlaceId: ID }));
    const typed = await experiences.create(input('typed-by-hand'));
    const fake = new FakeBusinessPlaces([place(7.9572, 80.7602)]);
    const out = await refreshExperiencePins({ experiences, business: fake });
    expect(out).toEqual({ checked: 1, moved: 1, failed: 0 });
    expect(fake.calls).toEqual([`location:${ID}`]);
    expect(await experiences.get(moved.id)).toMatchObject({ lat: 7.9572, lng: 80.7602, updatedBy: 'google-pin-refresh' });
    expect(await experiences.get(typed.id)).toMatchObject({ lat: 7.95, lng: 80.76, updatedBy: null });
  });

  it('an unchanged pin is re-fetched but not rewritten', async () => {
    const experiences = new InMemoryExperienceRepo();
    const e = await experiences.create(input('same', { googlePlaceId: ID }));
    const out = await refreshExperiencePins({ experiences, business: new FakeBusinessPlaces([place(7.95, 80.76)]) });
    expect(out).toEqual({ checked: 1, moved: 0, failed: 0 });
    expect((await experiences.get(e.id))!.updatedAt.getTime()).toBe(e.updatedAt.getTime());
  });

  it('a place Google no longer answers for is counted as failed and keeps its pin', async () => {
    const experiences = new InMemoryExperienceRepo();
    const e = await experiences.create(input('gone', { googlePlaceId: 'ChIJGone000000000000000' }));
    const out = await refreshExperiencePins({ experiences, business: new FakeBusinessPlaces([]) });
    expect(out).toEqual({ checked: 1, moved: 0, failed: 1 });
    expect(await experiences.get(e.id)).toMatchObject({ lat: 7.95, lng: 80.76 });
  });
});
