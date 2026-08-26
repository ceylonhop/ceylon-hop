// ════════════════════════════════════════════════════════════════════════════
//  Ceylon Hop — SEED THE RIDE BOARD (test fixture)
// ════════════════════════════════════════════════════════════════════════════
//
//  Fills the board with realistic lists so the pipeline and the UX can actually
//  be exercised: an empty board renders almost nothing, so nothing gets tested.
//  Covers every state the board can be in — a list one name short of running, a
//  van already locked in, a quiet new list, a nearly-full one, and a called-off
//  one — across real corridors at real seat prices.
//
//  USAGE
//    cd api
//    DATABASE_URL=<target> npx tsx scripts/seed-ride-board.ts          # seed
//    DATABASE_URL=<target> npx tsx scripts/seed-ride-board.ts --clear  # remove
//    DATABASE_URL=<target> npx tsx scripts/seed-ride-board.ts --list   # show
//
//  Every seeded row is tagged INTERNALLY — members carry a `seed-` sub prefix and lists a
//  `seed-rideboard` created_by — so --clear removes exactly what this wrote and nothing a real
//  customer created, without any of it showing on the board. Run --clear before real traffic.
// ════════════════════════════════════════════════════════════════════════════
import postgres from 'postgres';
import { PostgresRideListRepo } from '../src/db/postgresRideListRepo';
import { DEFAULT_CORRIDORS } from '../src/db/departureRepo';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at the environment you want to seed.');
  process.exit(1);
}

// Marks every row this script creates, so --clear can be exact.
const SEED_SUB = 'seed-rideboard:';
// Lists are marked by created_by, NOT by their note. The note is customer-visible copy on the
// board — tagging it printed "Boards welcome, we have roof space. [seed]" to real visitors
// (owner-caught, 2026-08-18). created_by is internal, already on the table, and unused by the
// board UI, so it marks the row without saying anything to anyone.
const SEED_CREATED_BY = 'seed-rideboard';
// The pre-2026-08-18 marker. Kept ONLY so --clear can still remove lists seeded before the
// change; nothing writes it any more. Safe to delete once no environment holds those rows.
const LEGACY_SEED_NOTE = '[seed]';

// Managed Postgres (Supabase/Render) needs TLS; a local scratch DB refuses it.
const host = (() => {
  try { return new URL(url).hostname; } catch { return ''; }
})();
const isLocal = host === 'localhost' || host === '127.0.0.1';
const sql = postgres(url, { ssl: isLocal ? false : 'require', max: 1 });
const repo = new PostgresRideListRepo(sql);

const arg = process.argv[2];
const seatPriceFor = (corridorId: string): number =>
  DEFAULT_CORRIDORS.find((c) => c.id === corridorId)?.seatPrice ?? 2000;

// A future date on a given weekday (3 = Wed, 6 = Sat — the shared service days).
function nextServiceDate(weekday: 3 | 6, weeksOut = 2): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + weeksOut * 7);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const daysBefore = (iso: string, days: number): Date =>
  new Date(Date.parse(`${iso}T02:00:00Z`) - days * 86_400_000);

// Plausible travellers — the mix of nationalities the board actually sees.
const PEOPLE = [
  ['Maya', 'DE'], ['Tom', 'AU'], ['Elise', 'AU'], ['Priya', 'CA'], ['Jonas', 'NL'],
  ['Sofia', 'ES'], ['Ravi', 'GB'], ['Lena', 'FR'], ['Marco', 'IT'], ['Anna', 'PL'],
  ['Yuki', 'JP'], ['Ben', 'IE'],
] as const;

interface Spec {
  label: string;
  corridorId: string;
  fromPlace: string;
  toPlace: string;
  weekday: 3 | 6;
  weeksOut: number;
  slot: 'morning' | 'afternoon';
  joiners: number;
  status?: 'gathering' | 'confirmed' | 'cancelled';
  lockedTime?: string;
  note?: string;
}

// One list per state the board can be in, so every branch of the UI renders.
const SPECS: Spec[] = [
  {
    label: 'one name short — the state that drives sharing',
    corridorId: 'airport-cultural', fromPlace: 'Colombo Airport (CMB)', toPlace: 'Kandy',
    weekday: 3, weeksOut: 2, slot: 'morning', joiners: 3,
    note: 'Landing 06:40, happy to wait for the group.',
  },
  {
    label: 'threshold met — van locked in',
    corridorId: 'hill-line', fromPlace: 'Kandy', toPlace: 'Ella',
    weekday: 6, weeksOut: 2, slot: 'morning', joiners: 4,
    status: 'confirmed', lockedTime: '08:00',
    note: 'Confirmed — meeting by the lake end.',
  },
  {
    label: 'nearly full — only one seat left',
    corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa',
    weekday: 6, weeksOut: 3, slot: 'morning', joiners: 5,
    status: 'confirmed', lockedTime: '08:30',
    note: 'Boards welcome, we have roof space.',
  },
  {
    // capacity is 6, so six joiners is genuinely full — this is the card that should offer
    // "Start another van" rather than a join button. Without it the full-van state, which is
    // the whole point of showing confirmed vans, is never actually exercised.
    label: 'FULL van — the prompt to start another on the same route',
    corridorId: 'airport-cultural', fromPlace: 'Colombo Airport (CMB)', toPlace: 'Sigiriya / Dambulla',
    weekday: 6, weeksOut: 2, slot: 'morning', joiners: 6,
    status: 'confirmed', lockedTime: '07:30',
    note: 'Full van — six of us, leaving sharp.',
  },
  {
    label: 'quiet new list — the "be the first" path',
    corridorId: 'ella-east', fromPlace: 'Ella', toPlace: 'Arugam Bay',
    weekday: 3, weeksOut: 3, slot: 'morning', joiners: 1,
    note: 'Surf trip — flexible on timing.',
  },
  {
    label: 'gathering with two',
    corridorId: 'south-coast', fromPlace: 'Galle', toPlace: 'Mirissa',
    weekday: 6, weeksOut: 4, slot: 'afternoon', joiners: 2,
  },
  {
    label: 'called off — nobody charged',
    corridorId: 'yala-south', fromPlace: 'Yala', toPlace: 'Galle',
    weekday: 3, weeksOut: 1, slot: 'morning', joiners: 2,
    status: 'cancelled',
    note: 'Did not reach four names by the cutoff.',
  },
];

async function clear(): Promise<void> {
  const lists = await sql<{ id: string; code: string }[]>`
    select id, code from ride_list
     where created_by = ${SEED_CREATED_BY}
        or note like ${'%' + LEGACY_SEED_NOTE + '%'}`;
  const members = await sql<{ list_id: string }[]>`
    delete from ride_list_member where sub like ${SEED_SUB + '%'} returning list_id`;
  if (lists.length) {
    await sql`delete from ride_list_member where list_id in ${sql(lists.map((l) => l.id))}`;
    await sql`delete from ride_list where id in ${sql(lists.map((l) => l.id))}`;
  }
  console.log(`removed ${lists.length} seeded list(s) and ${members.length} seeded member row(s)`);
}

async function show(): Promise<void> {
  const rows = await sql<{ code: string; from_place: string; to_place: string; date: string; status: string; note: string | null; created_by: string | null; n: number }[]>`
    select l.code, l.from_place, l.to_place, l.date, l.status, l.note, l.created_by,
           (select count(*) from ride_list_member m where m.list_id = l.id and m.status <> 'scratched') as n
    from ride_list l order by l.date asc`;
  if (!rows.length) return console.log('the board is empty');
  for (const r of rows) {
    // Operator-facing console output — the one place the word still belongs.
    const seeded = r.created_by === SEED_CREATED_BY || (r.note ?? '').includes(LEGACY_SEED_NOTE) ? ' [seed]' : '';
    console.log(`  ${r.code}  ${r.from_place} → ${r.to_place}  ${r.date}  ${r.status}  ${r.n} name(s)${seeded}`);
  }
}

async function seed(): Promise<void> {
  let made = 0;
  for (const [i, s] of SPECS.entries()) {
    const date = nextServiceDate(s.weekday, s.weeksOut);
    const seatPrice = seatPriceFor(s.corridorId);
    const list = await repo.createList({
      corridorId: s.corridorId,
      fromPlace: s.fromPlace,
      toPlace: s.toPlace,
      date,
      slot: s.slot,
      minSeats: 4,
      capacity: 6,
      seatPrice,
      note: s.note ?? null,
      cutoffAt: daysBefore(date, 2),
      createdBy: SEED_CREATED_BY,
    });

    for (let j = 0; j < s.joiners; j++) {
      const [firstName, country] = PEOPLE[(i * 3 + j) % PEOPLE.length];
      await repo.addMember(list.id, {
        sub: `${SEED_SUB}${list.code}:${j}`,
        firstName,
        country,
        email: `${firstName.toLowerCase()}.${list.code.toLowerCase()}@example.com`,
        photoUrl: null,
        preferredTime: s.lockedTime ?? null,
        seats: 1,
        preapprovalRef: null,
      });
    }

    if (s.status && s.status !== 'gathering') await repo.setStatus(list.id, s.status);
    if (s.lockedTime) await repo.lockDeparture(list.id, s.lockedTime);

    made++;
    console.log(`  ${list.code}  ${s.fromPlace} → ${s.toPlace}  ${date}  ${s.joiners}/4 names  — ${s.label}`);
  }
  console.log(`\nseeded ${made} list(s). Remove them with --clear before real traffic.`);
}

const run = arg === '--clear' ? clear : arg === '--list' ? show : seed;
run()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
