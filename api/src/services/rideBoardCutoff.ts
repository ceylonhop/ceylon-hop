import type { RideListRepo } from '../db/rideListRepo';
import type { TokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import type { EmailAdapter } from '../adapters/email';
import { committedSeats, popularTime, type Slot, type RideMember } from '../domain/rideList';
import { sendRideConfirmed, sendRideExpiredOptions, sendRideAtRisk } from './rideBoardEmails';

// ============================================================================
// Ride Board cutoff sweep — the pooled equivalent of sweepStaleSharedHolds.
// Pure over (now, deps); driven by the external-cron POST /admin/jobs tick.
// For each gathering list past its cutoff:
//   • enough names  → pin the popular departure time, charge every held card,
//     confirm, email everyone (at-risk email to any card that declined);
//   • not enough    → expire, email the fallback-ladder options; nobody charged.
// A confirmed/expired list no longer matches dueForCutoff, so it's naturally
// idempotent (no notification_log needed).
// ============================================================================

export interface RideBoardCutoffDeps {
  rideLists: RideListRepo;
  paygw: TokenizedPaymentAdapter;
  email: EmailAdapter;
  currency?: string;
}

export interface RideBoardCutoffResult {
  processed: number;
  confirmed: number;
  expired: number;
  charged: number;
  chargeFailed: number;
}

const liveSeats = (members: RideMember[]) => committedSeats(members);

export async function runRideBoardCutoff(now: Date, deps: RideBoardCutoffDeps): Promise<RideBoardCutoffResult> {
  const currency = deps.currency ?? 'USD';
  const due = await deps.rideLists.dueForCutoff(now);
  const res: RideBoardCutoffResult = { processed: 0, confirmed: 0, expired: 0, charged: 0, chargeFailed: 0 };

  for (const { list, members } of due) {
    res.processed++;
    const held = members.filter((m) => m.status === 'held' || m.status === 'charged');

    // Not enough names → expire; nobody is charged, everyone gets the options email.
    if (liveSeats(held) < list.minSeats) {
      await deps.rideLists.setStatus(list.id, 'expired');
      res.expired++;
      for (const m of held) await sendRideExpiredOptions(deps.email, { to: m.email, firstName: m.firstName, list });
      continue;
    }

    // Enough names → pin the group's popular departure time, then charge each held card.
    const time = popularTime(held.map((m) => m.preferredTime), list.slot as Slot);
    await deps.rideLists.lockDeparture(list.id, time);

    const chargedOk: RideMember[] = [];
    const failed: RideMember[] = [];
    for (const m of held) {
      if (m.status === 'charged') {
        chargedOk.push(m);
        continue;
      }
      const charge = await deps.paygw.charge({
        ref: m.preapprovalRef ?? '',
        amountCents: list.seatPrice * m.seats,
        currency,
        orderId: `${list.code}-${m.sub}`,
      });
      if (charge.status === 'succeeded') {
        await deps.rideLists.setMemberStatus(list.id, m.sub, 'charged');
        res.charged++;
        chargedOk.push(m);
      } else {
        await deps.rideLists.setMemberStatus(list.id, m.sub, 'charge_failed');
        res.chargeFailed++;
        failed.push(m);
      }
    }

    if (chargedOk.reduce((n, m) => n + m.seats, 0) >= list.minSeats) {
      // Confirmed with the successfully-charged travellers.
      await deps.rideLists.setStatus(list.id, 'confirmed');
      res.confirmed++;
      for (const m of chargedOk) await sendRideConfirmed(deps.email, { to: m.email, firstName: m.firstName, list, lockedTime: time });
      for (const m of failed) await sendRideAtRisk(deps.email, { to: m.email, firstName: m.firstName, list });
    } else {
      // Rare: enough held, but charge failures dropped it below the threshold. Expire and
      // offer the fallback. NOTE: any card already charged here needs a manual refund — the
      // real-money path (owner-gated PayHere swap) must add auto-refund. Flagged in the
      // go-live checklist.
      await deps.rideLists.setStatus(list.id, 'expired');
      res.expired++;
      for (const m of held) await sendRideExpiredOptions(deps.email, { to: m.email, firstName: m.firstName, list });
    }
  }

  return res;
}
