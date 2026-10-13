import { ExperienceInputSchema, type ExperienceInput } from './experience';

// Spec D20: three Sigiriya placeholders so staging has something to show. They are loaded into the
// STAGING database by pasting api/scripts/experience-placeholders.sql into its SQL editor — never a
// migration, never prod. Each reaches at most 10 km, which keeps all three off every other catalogue
// place (placeholders.test.ts proves it against transfers-data.js).
const DAILY = [0, 1, 2, 3, 4, 5, 6];
const DETAILS = 'PLACEHOLDER for staging tests. Not a real partner or price.';

export const PLACEHOLDERS: ExperienceInput[] = [
  {
    slug: 'placeholder-ayurvedic-massage', name: 'Ayurvedic massage', partnerName: 'Atherya Spa', areaLabel: 'Sigiriya',
    summary: 'A 90-minute Ayurvedic massage with herbal oils.', details: `${DETAILS} Massage.`,
    priceCents: 3500, priceUnit: 'per_person', durationText: '90 min', openWeekdays: DAILY,
    startTimes: ['09:00', '11:00', '14:00', '16:00'], lat: 7.977, lng: 80.76, radiusKm: 5,
    photos: ['guides/sigiriya/ayurveda'], partnerContact: null, active: true,
  },
  {
    slug: 'placeholder-village-cooking-lesson', name: 'Village cooking lesson', partnerName: 'Suwee', areaLabel: 'Sigiriya',
    summary: 'Cook a Sri Lankan village meal with a local family.', details: `${DETAILS} Cooking.`,
    priceCents: 2500, priceUnit: 'per_person', durationText: '3 hrs', openWeekdays: [1, 2, 3, 4, 5, 6],
    startTimes: ['10:00', '16:00'], lat: 7.95, lng: 80.796, radiusKm: 5,
    photos: ['guides/sigiriya/family-food', 'guides/sigiriya/village'], partnerContact: null, active: true,
  },
  {
    slug: 'placeholder-elephant-jeep-safari', name: 'Elephant jeep safari', partnerName: 'Sample jeep partner', areaLabel: 'Sigiriya',
    summary: 'A jeep safari to see wild elephants.', details: `${DETAILS} Safari.`,
    priceCents: 4500, priceUnit: 'per_group', durationText: '3-4 hrs', openWeekdays: DAILY,
    startTimes: ['14:00'], lat: 7.92, lng: 80.81, radiusKm: 10,
    photos: ['guides/sigiriya/elephants'], partnerContact: null, active: true,
  },
];

const COLUMNS = [
  'slug', 'name', 'partner_name', 'area_label', 'summary', 'details', 'price_cents', 'currency', 'price_unit',
  'duration_text', 'open_weekdays', 'start_times', 'lat', 'lng', 'radius_km', 'photos', 'partner_contact',
  'active', 'created_by',
];

const str = (s: string) => `'${s.replace(/'/g, "''")}'`;
const nullable = (s: string | null) => (s === null ? 'NULL' : str(s));
const arr = (items: Array<string | number>, type: 'integer' | 'text') =>
  items.length ? `ARRAY[${items.map((i) => (typeof i === 'number' ? String(i) : str(i))).join(', ')}]::${type}[]` : `'{}'::${type}[]`;

function row(input: ExperienceInput): string {
  const e = ExperienceInputSchema.parse(input);
  return `  (${[
    str(e.slug), str(e.name), str(e.partnerName), str(e.areaLabel), str(e.summary), str(e.details),
    String(e.priceCents), "'USD'", str(e.priceUnit), nullable(e.durationText),
    arr(e.openWeekdays, 'integer'), arr(e.startTimes, 'text'), String(e.lat), String(e.lng), String(e.radiusKm),
    arr(e.photos, 'text'), nullable(e.partnerContact), String(e.active), "'placeholder-seed'",
  ].join(', ')})`;
}

// The committed api/scripts/experience-placeholders.sql is this function's output, byte for byte
// (placeholders.test.ts checks it). Regenerate from api/:
//   npx tsx -e "import('./src/experiences/placeholders').then(m => process.stdout.write(m.placeholderSql()))" > scripts/experience-placeholders.sql
export function placeholderSql(): string {
  return [
    '-- STAGING ONLY. Never run this against production (spec 2026-10-06 D20).',
    '-- Generated from api/src/experiences/placeholders.ts — do not hand-edit; regenerate and commit.',
    '-- Paste into the STAGING Supabase SQL editor. Safe to re-run: existing slugs are skipped.',
    `INSERT INTO "experiences" (${COLUMNS.map((c) => `"${c}"`).join(', ')}) VALUES`,
    `${PLACEHOLDERS.map(row).join(',\n')}`,
    'ON CONFLICT ("slug") DO NOTHING;',
    '',
  ].join('\n');
}
