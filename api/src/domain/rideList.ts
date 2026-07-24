import { z } from 'zod';

// ============================================================================
// Ride Board domain — demand-pooling "lists" layered ON TOP OF the shared-taxi
// corridor catalogue (departureRepo). A list is a corridor route + a date +
// a coarse departure slot that travellers add their names to; when enough
// names commit by the cutoff, Ceylon Hop runs the van. This module is pure
// (Zod schemas + rules); all persistence lives in db/rideListRepo.ts.
//
// Reuse: corridor resolution, seat price and the seat-hold idiom come from the
// shared-taxi stack. Ride-board POLICY (threshold + van capacity) is separate,
// additive data here — it deliberately does NOT touch SHARED_CAPACITY (12),
// which governs the fixed shared-departure inventory, not pooled lists.
// ============================================================================

// Strict ISO calendar date — same rule as domain/shared.ts (kept local so this
// module doesn't reach into the shared-taxi domain).
const IsoDate = z.string().refine(
  (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  },
  { message: 'date must be a valid ISO calendar date (YYYY-MM-DD)' },
);

export const Slot = z.enum(['morning', 'afternoon']);
export type Slot = z.infer<typeof Slot>;

export const RideListStatus = z.enum(['gathering', 'confirmed', 'expired', 'cancelled']);
export type RideListStatus = z.infer<typeof RideListStatus>;

export const MemberStatus = z.enum(['held', 'charged', 'charge_failed', 'scratched']);
export type MemberStatus = z.infer<typeof MemberStatus>;

// Candidate departure times per slot — travellers mark a preference; the group's
// most-popular is pinned when the van locks (so a single fixed time never shrinks
// the pool). 'flex' is allowed as a preference but is not itself a departure time.
export const SLOT_TIMES: Record<Slot, string[]> = {
  morning: ['07:00', '08:00', '09:00'],
  afternoon: ['13:00', '14:00', '15:00'],
};

// Sri Lanka is a fixed UTC+05:30 (no DST), so a literal offset is exact and keeps
// cutoff math a pure string→instant computation (no Intl round-trips).
const SLK_OFFSET = '+05:30';
const CUTOFF_HOURS_BEFORE = 48;

/** The instant a list closes: `hoursBefore` before the window's earliest departure
 *  on the list's date, in Asia/Colombo. */
export function cutoffAt(date: string, slot: Slot, hoursBefore = CUTOFF_HOURS_BEFORE): Date {
  const windowStart = SLOT_TIMES[slot][0];
  const departure = new Date(`${date}T${windowStart}:00${SLK_OFFSET}`);
  return new Date(departure.getTime() - hoursBefore * 3600_000);
}

// Ride-board policy: how many names lock the van, and how many seats it holds.
// Per-corridor overridable data (van economics differ: 4×$14 ≠ 4×$24) without
// touching the shared-departure capacity. Defaults match the product design.
export interface RidePolicy {
  minSeats: number;
  capacity: number;
}
const DEFAULT_POLICY: RidePolicy = { minSeats: 4, capacity: 6 };
const POLICY_OVERRIDES: Record<string, Partial<RidePolicy>> = {};
export function policyForCorridor(corridorId: string): RidePolicy {
  return { ...DEFAULT_POLICY, ...(POLICY_OVERRIDES[corridorId] ?? {}) };
}

/** The group's most-popular preferred departure time, falling back to the middle
 *  of the window (a sensible default) when there are no explicit preferences. */
export function popularTime(prefs: Array<string | null | undefined>, slot: Slot): string {
  const times = SLOT_TIMES[slot];
  const fallback = times[1] ?? times[0];
  const counts = new Map<string, number>();
  for (const p of prefs) if (p && times.includes(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
  // Only a time with an actual preference can win; ties resolve to the earlier time
  // (strict >). With no preferences at all, fall back to the middle of the window.
  let best: string | null = null;
  let bestN = 0;
  for (const t of times) {
    const n = counts.get(t) ?? 0;
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best ?? fallback;
}

// ---- HTTP input shapes -----------------------------------------------------

// Create a list. The website sends place NAMES (from/to) exactly like the booking
// flow; a corridorId is also accepted. Threshold/capacity/price are derived
// server-side from the corridor — never trusted from the client.
export const CreateListInput = z
  .object({
    corridorId: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    date: IsoDate,
    slot: Slot,
    note: z.string().max(140).optional(),
    preferredTime: z.string().min(1).optional(),
    seats: z.number().int().min(1).max(4).optional(),
  })
  .refine((d) => Boolean(d.corridorId) || Boolean(d.from && d.to), {
    message: 'from and to (or corridorId) are required',
  });
export type CreateListInput = z.infer<typeof CreateListInput>;

// Add your name to an existing list. Identity comes from the customer session,
// not the body — the body only carries the traveller's choices.
export const JoinInput = z.object({
  preferredTime: z.string().min(1).optional(),
  seats: z.number().int().min(1).max(4).default(1),
});
export type JoinInput = z.infer<typeof JoinInput>;

// ---- Persistence records (shared by the repo interface + impls) ------------

export interface RideList {
  id: string;
  code: string; // short public code, e.g. "EM-4821"
  corridorId: string;
  fromPlace: string;
  toPlace: string;
  date: string; // ISO YYYY-MM-DD
  slot: Slot;
  lockedTime: string | null; // set when the van locks
  minSeats: number;
  capacity: number;
  seatPrice: number; // minor units (cents) — the corridor seat price
  status: RideListStatus;
  note: string | null;
  cutoffAt: Date;
  createdBy: string | null; // customer subject
  createdAt: Date;
  updatedAt: Date;
}

export interface RideMember {
  id: string;
  listId: string;
  position: number; // 1-based order on the list
  sub: string; // customer subject (Google)
  firstName: string;
  country: string;
  email: string;
  photoUrl: string | null;
  preferredTime: string | null;
  seats: number;
  preapprovalRef: string | null; // card-on-file token id (null while faked/unheld)
  status: MemberStatus;
  joinedAt: Date;
}

// A member counts toward the threshold/capacity while their hold is live.
export function countsForSeat(m: RideMember): boolean {
  return m.status === 'held' || m.status === 'charged';
}

/** Seats committed on a list (sum of live members' seat counts). */
export function committedSeats(members: RideMember[]): number {
  return members.filter(countsForSeat).reduce((n, m) => n + m.seats, 0);
}

// ---- Public code generation ------------------------------------------------

const A_Z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Two-letter route prefix from place names, e.g. Ella→Mirissa ⇒ "EM". */
export function routeInitials(fromPlace: string, toPlace: string): string {
  const letter = (s: string) => {
    for (const ch of s.toUpperCase()) if (A_Z.includes(ch)) return ch;
    return 'X';
  };
  return `${letter(fromPlace)}${letter(toPlace)}`;
}
/** Public list code from a route + a 4-digit suffix (caller supplies the digits so
 *  code generation stays pure/testable; the repo derives digits from the uuid). */
export function makeCode(fromPlace: string, toPlace: string, suffix: string): string {
  return `${routeInitials(fromPlace, toPlace)}-${suffix}`;
}
