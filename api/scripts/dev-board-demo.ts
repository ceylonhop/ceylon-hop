/* ============================================================
   Throwaway demo harness — NOT part of the app, NOT for deployment.

   Runs the real createApp() on IN-MEMORY repos so the route page can be walked
   end to end with live ride-board data. There is deliberately NO DATABASE here:
   api/.env's DATABASE_URL points at PRODUCTION, and nothing in a demo should be
   able to reach it. server.ts is bypassed for exactly that reason — it requires
   DATABASE_URL and would connect to prod.

   Seeds three lists on Negombo → Sigiriya so "Who's going" has something to show.

     cd api && npx tsx scripts/dev-board-demo.ts
     open http://localhost:4671/trip/negombo-to-sigiriya/?api=http://localhost:8787
   ============================================================ */
import { serve } from '@hono/node-server';
import { createApp } from '../src/app';
import { InMemoryRideListRepo } from '../src/db/rideListRepo';
import { sharedProductFor } from '../src/db/departureRepo';
import { cutoffAt, policyForCorridor } from '../src/domain/rideList';

const PORT = 8787;
const FROM = 'Negombo';
const TO = 'Sigiriya / Dambulla';

const rideLists = new InMemoryRideListRepo();

/** ISO date `n` days from today, in Colombo terms — good enough for a demo. */
function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

const product = sharedProductFor(FROM, TO);
if (!product) throw new Error(`no catalogue product for ${FROM} -> ${TO}`);
const policy = policyForCorridor(product.corridorId);

/* Three lists at different fill levels, so every row state is visible: one that
   needs a name, one just started, one already running. */
const SEED = [
  { days: 3, slot: 'morning' as const, names: ['Ama', 'Marek'] },
  { days: 9, slot: 'afternoon' as const, names: ['Sofia'] },
  { days: 16, slot: 'morning' as const, names: ['Priya', 'Luc', 'Dan'] },
];

for (const s of SEED) {
  const date = inDays(s.days);
  const list = await rideLists.createList({
    corridorId: product.corridorId,
    fromPlace: FROM,
    toPlace: TO,
    date,
    slot: s.slot,
    minSeats: policy.minSeats,
    capacity: policy.capacity,
    seatPrice: product.seatPrice,
    note: null,
    cutoffAt: cutoffAt(date, s.slot),
    createdBy: 'demo',
  });
  for (const [i, first] of s.names.entries()) {
    await rideLists.addMember(list.id, {
      sub: `demo-${list.code}-${i}`,
      firstName: first,
      country: 'LK',
      email: `${first.toLowerCase()}@example.com`,
      photoUrl: null,
      preferredTime: null,
      seats: 1,
      preapprovalRef: 'demo',
    });
  }
  console.log(`  seeded ${list.code}  ${date} ${s.slot}  ${s.names.length}/${policy.minSeats} names`);
}

const app = createApp({ rideLists });

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\n  demo API (in-memory, NO database) on http://localhost:${PORT}`);
  console.log(`  walk it: http://localhost:4671/trip/negombo-to-sigiriya/?api=http://localhost:${PORT}\n`);
});
