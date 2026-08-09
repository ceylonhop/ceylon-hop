import { randomUUID } from 'node:crypto';
import { canonPlace } from '../adapters/maps';

// A positively-identified place (spec 2026-08-02). See drizzle/0034_place_resolutions.sql for
// why identity is keyed on the canonical string rather than on the leg.
export interface PlaceResolution {
  id: string;
  canonKey: string;
  displayName: string;
  lat: number;
  lng: number;
  source: 'catalog' | 'confirmed' | 'auto_linked';
  confirmedBy: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

export interface NewPlaceResolution {
  canonKey: string;
  displayName: string;
  lat: number;
  lng: number;
  source?: 'catalog' | 'confirmed' | 'auto_linked';
  confirmedBy?: string | null;
}

export interface PlaceResolutionRepo {
  /** Exact lookup on the canonical key. */
  get(canonKey: string): Promise<PlaceResolution | null>;
  /** Every trusted row — the anchor set auto-link tests a new geocode against. */
  all(): Promise<PlaceResolution[]>;
  /** Idempotent on canonKey: confirming the same string twice must not duplicate or throw. */
  upsert(row: NewPlaceResolution): Promise<PlaceResolution>;
}

// The catalog seeds, mirroring drizzle/0034's INSERT. Kept here so the in-memory repo (tests,
// keyless dev) starts from the same 21 places production is seeded with — otherwise a test
// would exercise an empty catalog that no real environment ever has.
export const CATALOG_SEED: ReadonlyArray<{ canonKey: string; displayName: string; lat: number; lng: number }> = [
  { canonKey: 'colombo airport (cmb)', displayName: 'Colombo Airport (CMB)', lat: 7.18, lng: 79.88 },
  { canonKey: 'colombo city', displayName: 'Colombo City', lat: 6.93, lng: 79.85 },
  { canonKey: 'negombo', displayName: 'Negombo', lat: 7.21, lng: 79.84 },
  { canonKey: 'bentota', displayName: 'Bentota', lat: 6.42, lng: 79.99 },
  { canonKey: 'hikkaduwa', displayName: 'Hikkaduwa', lat: 6.14, lng: 80.1 },
  { canonKey: 'galle', displayName: 'Galle', lat: 6.03, lng: 80.22 },
  { canonKey: 'weligama', displayName: 'Weligama', lat: 5.97, lng: 80.42 },
  { canonKey: 'mirissa', displayName: 'Mirissa', lat: 5.95, lng: 80.46 },
  { canonKey: 'kandy', displayName: 'Kandy', lat: 7.29, lng: 80.63 },
  { canonKey: 'nuwara eliya', displayName: 'Nuwara Eliya', lat: 6.95, lng: 80.79 },
  { canonKey: 'ella', displayName: 'Ella', lat: 6.87, lng: 81.05 },
  { canonKey: 'sigiriya / dambulla', displayName: 'Sigiriya / Dambulla', lat: 7.95, lng: 80.76 },
  { canonKey: 'anuradhapura', displayName: 'Anuradhapura', lat: 8.31, lng: 80.4 },
  { canonKey: 'yala', displayName: 'Yala', lat: 6.37, lng: 81.52 },
  { canonKey: 'arugam bay', displayName: 'Arugam Bay', lat: 6.84, lng: 81.84 },
  { canonKey: 'trincomalee', displayName: 'Trincomalee', lat: 8.59, lng: 81.21 },
  { canonKey: 'polonnaruwa', displayName: 'Polonnaruwa', lat: 7.94, lng: 81.0 },
  { canonKey: 'habarana', displayName: 'Habarana', lat: 8.04, lng: 80.75 },
  { canonKey: 'nilaveli beach', displayName: 'Nilaveli Beach', lat: 8.7, lng: 81.19 },
  { canonKey: 'nanu oya', displayName: 'Nanu Oya', lat: 6.94, lng: 80.77 },
  { canonKey: 'thanthirimale', displayName: 'Thanthirimale', lat: 8.42, lng: 80.22 },
];

export class InMemoryPlaceResolutionRepo implements PlaceResolutionRepo {
  private rows = new Map<string, PlaceResolution>();

  /** `seeded: false` gives an empty catalog, for tests that need a place to be unknown. */
  constructor(seeded = true) {
    if (!seeded) return;
    for (const s of CATALOG_SEED) {
      this.rows.set(s.canonKey, {
        id: randomUUID(), ...s, source: 'catalog',
        confirmedBy: null, confirmedAt: null, createdAt: new Date(),
      });
    }
  }

  async get(canonKey: string): Promise<PlaceResolution | null> {
    return this.rows.get(canonPlace(canonKey)) ?? null;
  }

  async all(): Promise<PlaceResolution[]> {
    return [...this.rows.values()];
  }

  async upsert(row: NewPlaceResolution): Promise<PlaceResolution> {
    const key = canonPlace(row.canonKey);
    const existing = this.rows.get(key);
    const source = row.source ?? 'confirmed';
    const next: PlaceResolution = {
      id: existing?.id ?? randomUUID(),
      canonKey: key,
      displayName: row.displayName,
      lat: row.lat,
      lng: row.lng,
      source,
      confirmedBy: row.confirmedBy ?? null,
      confirmedAt: source === 'catalog' ? null : new Date(),
      createdAt: existing?.createdAt ?? new Date(),
    };
    this.rows.set(key, next);
    return next;
  }
}
