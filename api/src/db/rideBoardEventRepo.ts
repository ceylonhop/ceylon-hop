import { randomUUID } from 'node:crypto';

// ============================================================================
// Ride Board attempt log — one append-only row per thing a traveller tried to do on the
// board, whatever happened. ride_list / ride_list_member hold only where things ENDED UP (and a
// retry overwrites the member row), so the refusals, the abandoned card approvals and the
// failures in between were invisible. This is the record of the attempts themselves.
//
// Writing to it is best-effort: a traveller's join must never fail because the log did.
// ============================================================================

export type RideBoardAction = 'start' | 'join' | 'scratch';

export type RideBoardOutcome =
  | 'refused' // a 4xx: closed, full, cutoff_passed, sign_in_required, ...  (reason = error code)
  | 'payment_started' // handed to PayHere for card approval
  | 'payment_failed' // approval declined / cancelled / expired             (reason says which)
  | 'succeeded' // seat held, list started, or name scratched off
  | 'error'; // a 5xx

export interface RideBoardEventInput {
  action: RideBoardAction;
  outcome: RideBoardOutcome;
  reason?: string | null;
  httpStatus?: number | null;
  listCode?: string | null;
  corridorId?: string | null;
  fromPlace?: string | null;
  toPlace?: string | null;
  rideDate?: string | null;
  slot?: string | null;
  seats?: number | null;
  customerSub?: string | null;
  country?: string | null;
  orderId?: string | null;
}

export interface RideBoardEvent extends Required<{ [K in keyof RideBoardEventInput]: NonNullable<RideBoardEventInput[K]> | null }> {
  id: string;
  at: Date;
  action: RideBoardAction;
  outcome: RideBoardOutcome;
}

export interface RideBoardEventRepo {
  record(e: RideBoardEventInput, now?: Date): Promise<void>;
  // Oldest first.
  since(from: Date): Promise<RideBoardEvent[]>;
}

export function toEvent(e: RideBoardEventInput, now: Date): RideBoardEvent {
  return {
    id: randomUUID(),
    at: now,
    action: e.action,
    outcome: e.outcome,
    reason: e.reason ?? null,
    httpStatus: e.httpStatus ?? null,
    listCode: e.listCode ?? null,
    corridorId: e.corridorId ?? null,
    fromPlace: e.fromPlace ?? null,
    toPlace: e.toPlace ?? null,
    rideDate: e.rideDate ?? null,
    slot: e.slot ?? null,
    seats: e.seats ?? null,
    customerSub: e.customerSub ?? null,
    country: e.country ?? null,
    orderId: e.orderId ?? null,
  };
}

export class InMemoryRideBoardEventRepo implements RideBoardEventRepo {
  private readonly rows: RideBoardEvent[] = [];

  // Synchronous push: callers fire-and-forget, and tests read the log right after the response.
  record(e: RideBoardEventInput, now: Date = new Date()): Promise<void> {
    this.rows.push(toEvent(e, now));
    return Promise.resolve();
  }

  async since(from: Date): Promise<RideBoardEvent[]> {
    return this.rows.filter((r) => r.at.getTime() >= from.getTime()).map((r) => ({ ...r }));
  }

  // Test helper.
  all(): RideBoardEvent[] {
    return this.rows.map((r) => ({ ...r }));
  }
}
