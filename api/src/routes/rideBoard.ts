import { Hono } from 'hono';
import type { RideListRepo, RideListWithMembers, ListFilter } from '../db/rideListRepo';
import { committedSeats } from '../domain/rideList';

// ============================================================================
// Ride Board — public read endpoints. Everything here is unauthenticated and
// returns ONLY a customer-safe projection: first name + country + photo, never
// email, subject, or the preapproval token. (Writes — join/scratch/create —
// require the customer session and land in later slices.)
// ============================================================================

interface PublicMember {
  position: number;
  firstName: string;
  country: string;
  photoUrl: string | null;
  isStarter: boolean;
}

interface PublicList {
  code: string;
  corridorId: string;
  from: string;
  to: string;
  date: string;
  slot: string;
  lockedTime: string | null;
  minSeats: number;
  capacity: number;
  seatPrice: number; // minor units
  status: string;
  note: string | null;
  cutoffAt: string; // ISO
  committed: number; // live seats
  members: PublicMember[];
}

// The single place a list becomes public data — nothing sensitive leaves here.
export function projectList({ list, members }: RideListWithMembers): PublicList {
  const live = members.filter((m) => m.status === 'held' || m.status === 'charged');
  return {
    code: list.code,
    corridorId: list.corridorId,
    from: list.fromPlace,
    to: list.toPlace,
    date: list.date,
    slot: list.slot,
    lockedTime: list.lockedTime,
    minSeats: list.minSeats,
    capacity: list.capacity,
    seatPrice: list.seatPrice,
    status: list.status,
    note: list.note,
    cutoffAt: list.cutoffAt.toISOString(),
    committed: committedSeats(members),
    members: live
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        position: m.position,
        firstName: m.firstName,
        country: m.country,
        photoUrl: m.photoUrl,
        isStarter: m.position === 1,
      })),
  };
}

export function rideBoardRoutes(deps: { rideLists: RideListRepo }) {
  const r = new Hono();

  // GET /board?from=<place>&when=week|fortnight — open lists gathering names.
  r.get('/', async (c) => {
    const from = c.req.query('from')?.trim() || undefined;
    const whenRaw = c.req.query('when');
    const when: ListFilter['when'] =
      whenRaw === 'week' || whenRaw === 'fortnight' ? whenRaw : 'all';
    const lists = await deps.rideLists.listOpen({ from, when });
    return c.json({ lists: lists.map(projectList) });
  });

  // GET /board/:code — one list's public detail (the share-link destination).
  r.get('/:code', async (c) => {
    const found = await deps.rideLists.getByCode(c.req.param('code'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json(projectList(found));
  });

  return r;
}
