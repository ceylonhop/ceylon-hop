import { describe, expect, it } from 'vitest';
import { ExperienceInputSchema, aboutKm, toPublicExperience, type Experience } from './experience';

const valid = {
  slug: 'atherya-massage', name: 'Ayurvedic massage', partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
  summary: 'Full-body herbal oil massage and steam bath.', details: '', priceCents: 3500,
  priceUnit: 'per_person', durationText: '90 min', openWeekdays: [6, 1, 1, 0], startTimes: ['14:30', '09:00'],
  lat: 7.977, lng: 80.76, radiusKm: 5, photos: ['experiences/atherya-massage/treatment'], partnerContact: '+94 77 000 0000',
  active: true,
};

describe('ExperienceInputSchema', () => {
  it('accepts a valid experience and normalises weekdays and times (unique, sorted)', () => {
    const r = ExperienceInputSchema.parse(valid);
    expect(r.openWeekdays).toEqual([0, 1, 6]);
    expect(r.startTimes).toEqual(['09:00', '14:30']);
  });
  it('refuses a swapped "lng, lat" paste (outside Sri Lanka)', () => {
    expect(ExperienceInputSchema.safeParse({ ...valid, lat: 80.76, lng: 7.977 }).success).toBe(false);
  });
  it('refuses a bad time, a bad photo stem, a negative price and unknown fields', () => {
    expect(ExperienceInputSchema.safeParse({ ...valid, startTimes: ['9am'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, photos: ['../x'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, photos: ['treatment'] }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, priceCents: -1 }).success).toBe(false);
    expect(ExperienceInputSchema.safeParse({ ...valid, priority: 1 }).success).toBe(false);
  });
  it('tripadvisorLocationId: digits only (max 15), null by default and when cleared (D22)', () => {
    expect(ExperienceInputSchema.parse(valid).tripadvisorLocationId).toBeNull();
    expect(ExperienceInputSchema.parse({ ...valid, tripadvisorLocationId: '6789012' }).tripadvisorLocationId).toBe('6789012');
    expect(ExperienceInputSchema.parse({ ...valid, tripadvisorLocationId: null }).tripadvisorLocationId).toBeNull();
    for (const bad of ['', 'abc', '12a', ' 123', '1234567890123456', 'https://www.tripadvisor.com/x-d1-Reviews', 123]) {
      expect(ExperienceInputSchema.safeParse({ ...valid, tripadvisorLocationId: bad }).success, String(bad)).toBe(false);
    }
  });
  it('a partial (PATCH) leaves omitted fields undefined — defaults do not fire', () => {
    expect(ExperienceInputSchema.partial().strict().parse({ active: false })).toEqual({ active: false });
  });
});

describe('toPublicExperience', () => {
  it('never exposes partner contact, the pin or audit fields, and builds absolute photo URLs', () => {
    const e: Experience = { ...ExperienceInputSchema.parse({ ...valid, tripadvisorLocationId: '6789012' }), id: 'x', currency: 'USD',
      createdBy: 'a@b', updatedBy: null, createdAt: new Date(), updatedAt: new Date() };
    const json = JSON.stringify(toPublicExperience(e));
    expect(json).not.toContain('+94');
    expect(json).not.toContain('"lat"');
    expect(json).not.toContain('createdBy');
    expect(json).not.toContain('ripadvisor');
    expect(toPublicExperience(e).photos).toEqual([{
      small: 'https://ceylonhop.com/img/experiences/atherya-massage/treatment-900.jpg',
      large: 'https://ceylonhop.com/img/experiences/atherya-massage/treatment-1800.jpg',
    }]);
  });
});

describe('aboutKm', () => {
  it('road-adjusts straight-line km with the codebase’s own 1.35 factor (maps.ts fallback)', () => {
    expect(aboutKm(3)).toBe(4);
    expect(aboutKm(25)).toBe(34);
  });
});
