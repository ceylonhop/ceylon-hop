import { SLOT_TIMES, countsForSeat, type RideList, type RideMember } from '../domain/rideList';
import type { OpsBookingRow } from './opsView';

// ────────────────────────────────────────────────────────────────────────────
//  Ride board → ops queue (read-time projection, 2026-07-26)
//
//  A ride-board van has no booking, no quote and no payment row — the only
//  durable record is ride_list + ride_list_member. Ops still has to RUN these
//  vans, so this projects each list into the same row shape the Bookings queue
//  already speaks. One van = one row.
//
//  Deliberately read-only: nothing here writes back, so a board row can never
//  corrupt the booking queue, and the whole feature can be pulled by deleting
//  one concat in routes/ops.ts.
//
//  The manifest carries first name + country only. Member email and Google
//  subject never cross this boundary — same rule as the public board projection.
// ────────────────────────────────────────────────────────────────────────────

export interface RideListWithMembers {
  list: RideList;
  members: RideMember[];
}

export interface BoardRowOptions {
  currency: string;
}

/** The id namespace that keeps a van row from colliding with a booking uuid. */
export const BOARD_ROW_PREFIX = 'board:';

/** `board:EM-4821` → `EM-4821`; anything else → null. */
export function boardCodeFromRowId(id: string): string | null {
  return id.startsWith(BOARD_ROW_PREFIX) ? id.slice(BOARD_ROW_PREFIX.length) : null;
}

/**
 * When the van actually leaves. Once the cutoff locks a time that is the answer;
 * before then the best ops can say is the front of the slot window.
 */
function departureTime(list: RideList): string | null {
  return list.lockedTime ?? SLOT_TIMES[list.slot]?.[0] ?? null;
}

/**
 * A gathering van is its own stage — there is no payment to chase and no
 * vehicle to confirm until it locks. A confirmed van maps onto 'paid', which is
 * exactly right: the money is taken and it now needs a vehicle assigned, so it
 * lands in the existing "Needs vehicle" group alongside real bookings.
 */
function stageFor(list: RideList): OpsBookingRow['stage'] {
  return list.status === 'confirmed' ? 'paid' : 'gathering';
}

/**
 * Paid only when every name still on the van actually cleared. A charge_failed
 * member no longer holds a seat, so they cost nothing in seats or money — but
 * they are precisely the case ops must chase, so they keep the row unpaid.
 */
function paymentStatusFor(onboard: RideMember[]): 'paid' | 'unpaid' {
  return onboard.length > 0 && onboard.every((m) => m.status === 'charged') ? 'paid' : 'unpaid';
}

/**
 * "Ann" alone, "Ann +2" with a group — the starter is who ops calls, the count
 * is how many they are collecting.
 */
function groupName(live: RideMember[]): { first: string; full: string } {
  const ordered = [...live].sort((a, b) => a.position - b.position);
  const starter = ordered[0];
  const first = starter?.firstName ?? 'Ride board';
  const others = ordered.length - 1;
  return { first, full: others > 0 ? `${first} +${others}` : first };
}

/** Project one ride-board list into an ops queue row. */
export function rideListToOpsRow(
  { list, members }: RideListWithMembers,
  opts: BoardRowOptions,
): OpsBookingRow {
  // Seats and money count only live holds; the manifest also keeps failed
  // charges visible, because someone has to ring them before the van leaves.
  const live = members.filter(countsForSeat);
  const onboard = members.filter((m) => m.status !== 'scratched');
  const seats = live.reduce((n, m) => n + m.seats, 0);
  const name = groupName(live);
  return {
    id: `${BOARD_ROW_PREFIX}${list.code}`,
    reference: list.code,
    mode: 'board',
    channel: 'website',
    bookingStatus: list.status,
    stage: stageFor(list),
    paymentStatus: paymentStatusFor(onboard),
    amount: list.seatPrice * seats,
    currency: opts.currency,
    customerFirstName: name.first,
    customerName: name.full,
    route: `${list.fromPlace} → ${list.toPlace}`,
    travelDate: list.date,
    travelTime: departureTime(list),
    pax: seats,
    // Board vans have no ride_ops overlay — these flags exist only for bookings.
    vehiclePhotoReceived: false,
    customerUpdated: false,
    opsNotes: list.note,
    source: 'ride_board',
    board: {
      code: list.code,
      listStatus: list.status,
      seatsCommitted: seats,
      minSeats: list.minSeats,
      capacity: list.capacity,
      seatPrice: list.seatPrice,
      cutoffAt: list.cutoffAt.toISOString(),
      members: [...onboard]
        .sort((a, b) => a.position - b.position)
        .map((m) => ({
          position: m.position,
          firstName: m.firstName,
          country: m.country,
          seats: m.seats,
          status: m.status,
        })),
    },
  };
}

/**
 * Every van worth showing ops: at least one live name on it. A list nobody
 * joined — or one everybody scratched off — is not a vehicle, so it is not a row.
 */
export function boardRowsForOps(
  lists: RideListWithMembers[],
  opts: BoardRowOptions,
): OpsBookingRow[] {
  return lists
    .filter(({ members }) => members.some(countsForSeat))
    .map((l) => rideListToOpsRow(l, opts));
}
