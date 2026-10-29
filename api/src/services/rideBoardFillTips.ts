import type { RideListRepo } from '../db/rideListRepo';
import type { AlertLogRepo } from '../db/alertLogRepo';
import type { SendBudget } from './sendBudget';
import { committedSeats, countsForSeat, isSeedMember, type RideList, type RideMember } from '../domain/rideList';
import { logEvent } from '../observability/events';

// ============================================================================
// "How to fill your van" (owner ask 2026-10-27). A traveller who puts their name on a ride
// that is still short gets ONE email, a day later, telling them where to post it: the groups
// that fill vans, the message already written, their link already inside every button. Every
// live member gets their own — the starter and each joiner — because three people posting
// beats one. Nobody gets it twice, and nobody gets it for a van that no longer needs it.
//
// Pure over (now, deps); rides the daily POST /admin/jobs/notifications tick, so "a day later"
// means the first late-morning tick at least 24h after they joined. Idempotent through the
// alert ledger, one row per (list, member), never expiring — which also makes the first real
// run the backfill for everyone already on the board. A failed send is rolled back so the
// next tick retries it. The sender is injected: the template lives in rideBoardEmails.ts and
// this sweep only decides WHO and WHEN.
// ============================================================================

const LEDGER_KIND = 'ride_board_fill_tip';
// "Never again" — the ledger takes a cooldown, so use one longer than the product will live.
const FOREVER_MS = 100 * 365 * 86_400_000;
const WAIT_MS = 24 * 3600_000;
const SAMPLE_MAX = 10;

export interface FillTipArgs {
  to: string;
  firstName: string;
  list: RideList;
  member: RideMember;
  /** Live seats on the list now, so the mail can say "3 more and it runs". */
  committed: number;
  /** The list's creator, taking their own first seat; their post says "I've started", a joiner's "join me". */
  isStarter: boolean;
}

export type FillTipSender = (args: FillTipArgs) => Promise<unknown>;

export interface FillTipsDeps {
  rideLists: RideListRepo;
  send: FillTipSender;
  alertLog?: AlertLogRepo;
  // Blast-radius cap shared with the rest of the tick. One claim per mail; held back when
  // the cap is spent, nothing claimed in the ledger, so a later tick with room sends it.
  budget?: SendBudget;
  dryRun?: boolean;
}

export interface FillTipsResult {
  lists: number; // gathering, short of minSeats, future cutoff
  due: number; // live, real members on them who joined 24h+ ago
  sent: number;
  skipped: number; // already sent by an earlier tick
  failed: number; // provider rejected; released for the next tick
  suppressed: number; // held back by the send budget
  dryRun: boolean;
  ledger: boolean; // false = no alert ledger wired, so a re-run WOULD re-send
  sample: string[]; // first few "CODE:sub" keys due, so a human can go and look
}

export async function runRideBoardFillTips(now: Date, deps: FillTipsDeps): Promise<FillTipsResult> {
  const dryRun = deps.dryRun === true;
  const res: FillTipsResult = {
    lists: 0, due: 0, sent: 0, skipped: 0, failed: 0, suppressed: 0, dryRun, ledger: !!deps.alertLog, sample: [],
  };
  const open = (await deps.rideLists.listOpen({ when: 'all' }, now)).filter(
    ({ list, members }) =>
      list.status === 'gathering' && list.cutoffAt.getTime() > now.getTime() && committedSeats(members) < list.minSeats,
  );
  for (const { list, members } of open) {
    res.lists += 1;
    const committed = committedSeats(members);
    const due = members
      .filter((m) => countsForSeat(m) && !isSeedMember(m) && !!m.email && m.joinedAt.getTime() + WAIT_MS <= now.getTime())
      .sort((a, b) => a.position - b.position);
    for (const member of due) {
      res.due += 1;
      const key = `${list.code}:${member.sub}`;
      if (res.sample.length < SAMPLE_MAX) res.sample.push(key);
      if (dryRun) continue;
      if (deps.budget && !deps.budget.tryClaim(1)) {
        deps.budget.suppress('ride_board_fill_tip', key, 1);
        res.suppressed += 1;
        continue;
      }
      const reservedAt = now;
      const dedupeKey = `${list.id}:${member.sub}`;
      if (deps.alertLog && !(await deps.alertLog.shouldSend(LEDGER_KIND, dedupeKey, FOREVER_MS, reservedAt))) {
        res.skipped += 1;
        continue;
      }
      try {
        await deps.send({
          to: member.email,
          firstName: member.firstName,
          list,
          member,
          committed,
          isStarter: list.createdBy === member.sub,
        });
        res.sent += 1;
        logEvent('ride_board.fill_tip_sent', { code: list.code, starter: list.createdBy === member.sub });
      } catch (err) {
        res.failed += 1;
        console.error(`ride board fill tip: send failed for ${key}:`, err);
        await deps.alertLog?.rollback(LEDGER_KIND, dedupeKey, reservedAt);
      }
    }
  }
  return res;
}
