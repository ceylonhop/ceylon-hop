import { randomUUID } from 'node:crypto';
import type { HotZone } from '../quote/hotZones';

// A stored hot zone (mirrors the pricing_zones table). `active` is concrete once persisted; the
// geo trio is all-or-nothing (validated in the route).
export interface ZoneRow {
  id: string;
  placeName: string;
  boostPct: number;
  active: boolean;
  lat: number | null;
  lng: number | null;
  radiusKm: number | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewZone {
  placeName: string;
  boostPct: number;
  active?: boolean;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number | null;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export interface ZonePatch {
  placeName?: string;
  boostPct?: number;
  active?: boolean;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number | null;
  updatedBy?: string | null;
}

export interface ZonesRepo {
  // The active zones composed onto the live rate card per request. Returns [] when the kill switch
  // HOT_ZONES_DISABLED=1 is set — one env flip turns a fat-fingered zone incident into a non-event
  // (spec D4) without touching data.
  activeZones(): Promise<HotZone[]>;
  // All zones incl. inactive, for the founder admin panel (newest first).
  list(): Promise<ZoneRow[]>;
  get(id: string): Promise<ZoneRow | null>;
  create(z: NewZone): Promise<ZoneRow>;
  patch(id: string, p: ZonePatch): Promise<ZoneRow | null>;
  remove(id: string): Promise<boolean>;
}

export function hotZonesDisabled(): boolean {
  return process.env.HOT_ZONES_DISABLED === '1';
}

// Map a stored row → the engine's HotZone (only the fields the matcher needs). The geo trio rides
// along only when fully present.
export function toHotZone(r: ZoneRow): HotZone {
  const z: HotZone = { placeName: r.placeName, boostPct: r.boostPct, active: r.active };
  if (r.lat != null && r.lng != null && r.radiusKm != null) {
    z.lat = r.lat;
    z.lng = r.lng;
    z.radiusKm = r.radiusKm;
  }
  return z;
}

export class InMemoryZonesRepo implements ZonesRepo {
  private rows = new Map<string, ZoneRow>();

  async activeZones(): Promise<HotZone[]> {
    if (hotZonesDisabled()) return [];
    return [...this.rows.values()].filter((r) => r.active).map(toHotZone);
  }

  async list(): Promise<ZoneRow[]> {
    return [...this.rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async get(id: string): Promise<ZoneRow | null> {
    return this.rows.get(id) ?? null;
  }

  async create(z: NewZone): Promise<ZoneRow> {
    const now = new Date();
    const row: ZoneRow = {
      id: randomUUID(),
      placeName: z.placeName,
      boostPct: z.boostPct,
      active: z.active ?? true,
      lat: z.lat ?? null,
      lng: z.lng ?? null,
      radiusKm: z.radiusKm ?? null,
      createdBy: z.createdBy ?? null,
      updatedBy: z.updatedBy ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async patch(id: string, p: ZonePatch): Promise<ZoneRow | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next: ZoneRow = {
      ...row,
      placeName: p.placeName ?? row.placeName,
      boostPct: p.boostPct ?? row.boostPct,
      active: p.active ?? row.active,
      lat: p.lat !== undefined ? p.lat : row.lat,
      lng: p.lng !== undefined ? p.lng : row.lng,
      radiusKm: p.radiusKm !== undefined ? p.radiusKm : row.radiusKm,
      updatedBy: p.updatedBy ?? row.updatedBy,
      updatedAt: new Date(),
    };
    this.rows.set(id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}
