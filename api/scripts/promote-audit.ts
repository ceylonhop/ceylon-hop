import { createDb } from '../src/db/client';

// Promote audit — a READ-ONLY census of the operational data, taken before a promote and
// again after, so "nothing was lost or silently restated" is something you can DIFF rather
// than something you hope.
//
// Written because the team now runs real quotes through /ops end to end (create → review →
// approve → mark sent → mark booked) while the public site is still dark. That data has no
// other home, so a promote must be provably non-destructive to it.
//
// DELIBERATELY does NOT load api/.env. That file holds the PRODUCTION DATABASE_URL, and a
// script that picks it up implicitly is one typo away from pointing at prod when you meant
// staging. Pass the URL explicitly:
//
//   DATABASE_URL='postgres://…' npx tsx scripts/promote-audit.ts > before.json
//   # …promote…
//   DATABASE_URL='postgres://…' npx tsx scripts/promote-audit.ts > after.json
//   diff before.json after.json     # ← empty means every count survived
//
// Read-only by construction: every statement below is a SELECT. It opens no transaction,
// writes nothing, and is safe to run against production at any time.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is required, and is deliberately NOT read from api/.env — pass it explicitly:\n' +
      "  DATABASE_URL='postgres://…' npx tsx scripts/promote-audit.ts",
  );
  process.exit(2);
}

const { sql } = createDb(databaseUrl);

type Row = Record<string, unknown>;
const rows = async (label: string, run: () => Promise<Row[]>): Promise<[string, Row[]]> => [label, await run()];

async function main() {
  const census = await Promise.all([
    // ── The team's quote lifecycle. A promote must not move a single quote between states.
    rows('quotes_by_status', () => sql`
      select status, count(*)::int as n, coalesce(sum(total_cents), 0)::bigint as total_cents
      from quotes where deleted_at is null group by status order by status`),
    // Soft-deleted rows are the ones a sweep could have taken. Watch this number: it should
    // be identical before and after, and only ever grow by deletions a human performed.
    rows('quotes_soft_deleted', () => sql`
      select coalesce(deleted_by, '(unknown)') as deleted_by, count(*)::int as n
      from quotes where deleted_at is not null group by 1 order by 1`),
    // Only rows carrying the {shell:true} marker can ever be touched by the abandoned-draft
    // sweep. Anything the team built through Save has {tool,engine} and is invisible to it.
    rows('quotes_shell_marker', () => sql`
      select coalesce(request_json -> 'shell' = 'true'::jsonb, false) as is_shell,
             count(*)::int as n
      from quotes where deleted_at is null group by 1 order by 1`),
    rows('quotes_by_channel', () => sql`
      select channel, count(*)::int as n from quotes where deleted_at is null group by 1 order by 1`),
    // Conversions: a won quote linked to a booking is the end of the team's flow. The link
    // must survive intact.
    rows('quotes_converted', () => sql`
      select (converted_booking_id is not null) as converted, status, count(*)::int as n
      from quotes where deleted_at is null group by 1, 2 order by 1, 2`),

    // ── Bookings. The lifecycle mirror only writes FORWARD on new pipeline actions, so every
    // count here must be unchanged by the promote itself.
    rows('bookings_by_status', () => sql`
      select status, count(*)::int as n, coalesce(sum(total), 0)::bigint as total
      from bookings group by status order by status`),
    // The cross-tab that decides whether a backfill is worth writing: bookings whose ops
    // pipeline already finished but whose money-side status never followed (it couldn't —
    // nothing wrote past 'paid' before this release).
    rows('bookings_vs_fulfilment', () => sql`
      select b.status as booking_status,
             coalesce(r.fulfilment_status, '(none)') as fulfilment_status,
             count(*)::int as n
      from bookings b left join ride_ops r on r.booking_id = b.id
      group by 1, 2 order by 3 desc, 1, 2`),

    // ── Money. Nothing in this release rewrites a payment; the only schema change widens a
    // CHECK. Captured totals are the load-bearing number for refunds, so they are censused.
    rows('payments_by_provider_status', () => sql`
      select provider, status, count(*)::int as n, coalesce(sum(amount), 0)::bigint as amount
      from payments group by 1, 2 order by 1, 2`),
    rows('refunds_by_status', () => sql`
      select status, count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as amount_cents
      from refunds group by 1 order by 1`),
  ]);

  // Stable key order + integers-as-strings so the JSON diffs cleanly across runs.
  const out: Record<string, unknown> = {};
  for (const [label, value] of census) out[label] = value.map((r) => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))));
  console.log(JSON.stringify(out, null, 2));
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('promote audit failed:', err);
  process.exit(1);
});
