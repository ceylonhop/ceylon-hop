import { assertRideTransition, type RideStatus } from '../domain/rideStatus';

export interface RideOps {
  bookingId: string;
  coordinatorId: string | null;
  fulfilmentStatus: RideStatus;
  vehiclePhotoReceived: boolean;
  customerUpdated: boolean;
  opsNotes: string | null;
  assignedAt: string | null;
  sentAt: string | null;
  acknowledgedAt: string | null;
  vehicleConfirmedAt: string | null;
  updatedAt: string;
}

export interface RideOpsRepo {
  getOrCreate(bookingId: string): Promise<RideOps>;
  get(bookingId: string): Promise<RideOps | null>;
  assign(bookingId: string, coordinatorId: string | null): Promise<RideOps>;
  setStatus(bookingId: string, to: RideStatus): Promise<RideOps>;
  setFlags(bookingId: string, flags: { vehiclePhotoReceived?: boolean; customerUpdated?: boolean; opsNotes?: string | null }): Promise<RideOps>;
  listByBookingIds(ids: string[]): Promise<RideOps[]>;
}

function blank(bookingId: string): RideOps {
  const now = new Date().toISOString();
  return {
    bookingId, coordinatorId: null, fulfilmentStatus: 'unassigned',
    vehiclePhotoReceived: false, customerUpdated: false, opsNotes: null,
    assignedAt: null, sentAt: null, acknowledgedAt: null, vehicleConfirmedAt: null, updatedAt: now,
  };
}

export class InMemoryRideOpsRepo implements RideOpsRepo {
  private byId = new Map<string, RideOps>();
  private touch(r: RideOps): RideOps { r.updatedAt = new Date().toISOString(); this.byId.set(r.bookingId, r); return { ...r }; }

  async getOrCreate(bookingId: string): Promise<RideOps> {
    const existing = this.byId.get(bookingId);
    if (existing) return { ...existing };
    const row = blank(bookingId);
    this.byId.set(bookingId, row);
    return { ...row };
  }
  async get(bookingId: string): Promise<RideOps | null> {
    const r = this.byId.get(bookingId);
    return r ? { ...r } : null;
  }
  async assign(bookingId: string, coordinatorId: string | null): Promise<RideOps> {
    const r = this.byId.get(bookingId) ?? blank(bookingId);
    r.coordinatorId = coordinatorId;
    r.assignedAt = new Date().toISOString();
    if (coordinatorId && r.fulfilmentStatus === 'unassigned') r.fulfilmentStatus = 'assigned';
    if (!coordinatorId) r.fulfilmentStatus = 'unassigned';
    return this.touch(r);
  }
  async setStatus(bookingId: string, to: RideStatus): Promise<RideOps> {
    const r = this.byId.get(bookingId) ?? blank(bookingId);
    assertRideTransition(r.fulfilmentStatus, to);
    r.fulfilmentStatus = to;
    if (to === 'sent_to_coordinator') r.sentAt = new Date().toISOString();
    if (to === 'acknowledged') r.acknowledgedAt = new Date().toISOString();
    if (to === 'vehicle_confirmed') r.vehicleConfirmedAt = new Date().toISOString();
    return this.touch(r);
  }
  async setFlags(bookingId: string, flags: { vehiclePhotoReceived?: boolean; customerUpdated?: boolean; opsNotes?: string | null }): Promise<RideOps> {
    const r = this.byId.get(bookingId) ?? blank(bookingId);
    if (flags.vehiclePhotoReceived !== undefined) r.vehiclePhotoReceived = flags.vehiclePhotoReceived;
    if (flags.customerUpdated !== undefined) r.customerUpdated = flags.customerUpdated;
    if (flags.opsNotes !== undefined) r.opsNotes = flags.opsNotes;
    return this.touch(r);
  }
  async listByBookingIds(ids: string[]): Promise<RideOps[]> {
    return ids.map((id) => this.byId.get(id)).filter((r): r is RideOps => !!r).map((r) => ({ ...r }));
  }
}
