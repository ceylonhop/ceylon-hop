import type { RideListRepo } from '../db/rideListRepo';
import type { EmailAdapter } from '../adapters/email';
import type { AlertLogRepo } from '../db/alertLogRepo';
import { committedSeats, countsForSeat, isSeedMember } from '../domain/rideList';
import { sendRideSeatHeld } from './opsNotifications';

// ============================================================================
// One-shot catch-up for the ops "seat held" mail (owner ask 2026-09-22).
//
// #702 tells ops about every NEW commitment on the Ride Board. Seats held before it shipped
// were never announced, so ops had no picture of the rides already gathering. This job mails
// ops once per live, real seat on every list that is still gathering with a future cutoff —
// and nothing else: a list past its cutoff belongs to the sweep, a confirmed one already
// produced its confirmation, and a cancelled one is over.
//
// Idempotent through the alert ledger: one row per (list, member), never expiring. Running
// it twice sends nothing the second time. A failed send is rolled back so the next run
// retries it. Deliberately outside the notification send budget — one ops recipient,
// bounded by the number of open lists, nothing a backfill can multiply.
// ============================================================================

const LEDGER_KIND = 'ride_board_seat_held_backfill';
// "Never again" — the ledger takes a cooldown, so use one longer than the product will live.
const FOREVER_MS = 100 * 365 * 86_400_000;

export interface BoardOpsBackfillDeps {
  rideLists: RideListRepo;
  email: EmailAdapter;
  to: string;
  opsBaseUrl?: string;
  alertLog?: AlertLogRepo;
  dryRun?: boolean;
}

export interface BoardOpsBackfillResult {
  lists: number; // gathering lists with a future cutoff
  seats: number; // live, real members on them (seed placeholders excluded)
  sent: number;
  skipped: number; // already announced by an earlier run
  failed: number; // provider rejected; released for the next run
  dryRun: boolean;
  ledger: boolean; // false = no alert ledger wired, so a re-run WOULD re-send
  sample: string[]; // first few "CODE:sub" keys touched, so a human can go and look
}

const SAMPLE_MAX = 10;

export async function runBoardOpsBackfill(now: Date, deps: BoardOpsBackfillDeps): Promise<BoardOpsBackfillResult> {
  const dryRun = deps.dryRun === true;
  const res: BoardOpsBackfillResult = {
    lists: 0, seats: 0, sent: 0, skipped: 0, failed: 0, dryRun, ledger: !!deps.alertLog, sample: [],
  };
  const open = (await deps.rideLists.listOpen({ when: 'all' }, now)).filter(
    ({ list }) => list.status === 'gathering' && list.cutoffAt.getTime() > now.getTime(),
  );
  for (const { list, members } of open) {
    res.lists += 1;
    const committed = committedSeats(members);
    const live = members
      .filter((m) => countsForSeat(m) && !isSeedMember(m) && !!m.email)
      .sort((a, b) => a.position - b.position);
    for (const member of live) {
      res.seats += 1;
      const key = `${list.code}:${member.sub}`;
      if (res.sample.length < SAMPLE_MAX) res.sample.push(key);
      if (dryRun) continue;
      const reservedAt = now;
      if (deps.alertLog && !(await deps.alertLog.shouldSend(LEDGER_KIND, `${list.id}:${member.sub}`, FOREVER_MS, reservedAt))) {
        res.skipped += 1;
        continue;
      }
      try {
        await sendRideSeatHeld(
          {
            to: deps.to,
            list,
            member,
            committed,
            kind: list.createdBy === member.sub ? 'started' : 'joined',
          },
          deps.email,
          deps.opsBaseUrl ?? '',
        );
        res.sent += 1;
      } catch (err) {
        res.failed += 1;
        console.error(`board ops backfill: send failed for ${key}:`, err);
        await deps.alertLog?.rollback(LEDGER_KIND, `${list.id}:${member.sub}`, reservedAt);
      }
    }
  }
  return res;
}
