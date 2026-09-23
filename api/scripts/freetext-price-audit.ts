// Free-text endpoint audit — did a place string we never positively identified ever set a price?
//
// Background (2026-09-22). /quote/v2/estimate accepts any free-text endpoint and prices whatever
// Google resolves it to, WITHOUT the `estimated` flag — so /v2/lock and checkout will charge on
// it. Measured on prod: Kandy -> "Airport, Sri Lanka" prices 87 km / $39.99, while the real
// Kandy -> Colombo Airport (CMB) is 119 km / $58.00. Google resolves the bare word to an inland
// airstrip (triangulated: 83 km from Anuradhapura, 108 from Trincomalee).
//
// The two guards in src/adapters/maps.ts both miss it. MAX_SL_ROAD_KM rejects a geocode that
// landed in ANOTHER COUNTRY -- too long. The MIN_ROAD_TO_CROW floor catches too-SHORT, which is
// the direction that undercharges, but it only runs when BOTH endpoints are catalogue towns
// (`if (o && d)`), because only then do we hold coordinates Google did not give us. A free-text
// endpoint has none, so the check is skipped exactly where we trust Google most.
//
// This script does NOT fix that. It answers the prior question -- is it happening to real
// customers, and how often -- so the fix can be sized from data rather than from argument.
// Nothing here is automatic: section 1 is a list for a human to read, because only a human knows
// that "Airport, Sri Lanka" is wrong and "Jetwing Lighthouse, Galle" is fine.
//
//   DATABASE_URL='postgres://...' npx tsx scripts/freetext-price-audit.ts
//
// READ-ONLY by construction: every statement below is a SELECT, and there is no write path in
// this file. Offline and free -- it NEVER calls Google; section 2's floor is computed from the
// catalogue coordinates we already hold.
//
// DELIBERATELY does NOT load api/.env -- same reason as scripts/promote-audit.ts and
// scripts/pricing-health.ts: that file holds the PRODUCTION DATABASE_URL, and a script that picks
// it up implicitly is one typo away from pointing at prod when you meant staging. Pass it above.
import { createDb } from '../src/db/client';
import { KNOWN_PLACES, canonPlace, haversineKm, isCatalogTown, knownCoords } from '../src/adapters/maps';

// Mirrors MIN_ROAD_TO_CROW in src/adapters/maps.ts. Duplicated rather than exported because this
// is a historical audit: it must keep measuring what the guard meant on the day these rows were
// written, even if the live constant is retuned later.
const FLOOR_RATIO = 0.95;

interface TransferRow {
  reference: string;
  status: string;
  created_at: Date;
  from_place: string;
  to_place: string;
  distance_km: number | null;
}

interface TripRow {
  reference: string;
  status: string;
  created_at: Date;
  stops: string[];
}

/** One free-text endpoint, with every booking that priced against it. */
interface Usage {
  label: string;
  bookings: { reference: string; status: string; km: number | null; pair: string }[];
}

// A string that is one of OUR places said differently -- "Colombo Airport" for the catalogue's
// "Colombo Airport (CMB)". It still reached Google as words, so it belongs in the list, but it is
// a different risk from a category word: the words DO name the place we meant, they just missed
// an exact catalogue match. Separating the two is what makes the list readable.
function nearCatalogue(place: string): boolean {
  const k = canonPlace(place).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!k) return false;
  return KNOWN_PLACES.some((town) => {
    const t = canonPlace(town).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return !!t && (t === k || t.startsWith(`${k} `) || k.startsWith(`${t} `));
  });
}

function tally(usages: Map<string, Usage>, place: string, entry: Usage['bookings'][number]): void {
  if (!place || !place.trim() || isCatalogTown(place)) return;
  const key = canonPlace(place);
  const found = usages.get(key) ?? { label: place.trim(), bookings: [] };
  found.bookings.push(entry);
  usages.set(key, found);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      'DATABASE_URL is required (pass it explicitly -- this script never reads api/.env).\n' +
        "  DATABASE_URL='postgres://...' npx tsx scripts/freetext-price-audit.ts",
    );
    process.exitCode = 1;
    return;
  }
  const { sql } = createDb(databaseUrl);
  try {
    const transfers = (await sql`
      select b.reference, b.status, b.created_at,
             t.from_place, t.to_place, t.distance_km
        from transfer_request t
        join bookings b on b.id = t.booking_id
       order by b.created_at desc
    `) as unknown as TransferRow[];
    const trips = (await sql`
      select b.reference, b.status, b.created_at, t.stops
        from trip_request t
        join bookings b on b.id = t.booking_id
       order by b.created_at desc
    `) as unknown as TripRow[];

    console.log(`# Free-text endpoint audit -- ${new Date().toISOString().slice(0, 10)}\n`);
    console.log(`Scanned ${transfers.length} single transfers and ${trips.length} trips.\n`);

    // ── Section 1: which free-text endpoints real bookings actually priced against ──────────
    // A catalogue town carries a verified coordinate, so it is never in danger. Everything else
    // reached Google as words, and this is the complete list of those words.
    const usages = new Map<string, Usage>();
    const transferRefs = new Set(transfers.map((t) => t.reference));
    for (const t of transfers) {
      const pair = `${t.from_place} -> ${t.to_place}`;
      const entry = { reference: t.reference, status: t.status, km: t.distance_km, pair };
      tally(usages, t.from_place, entry);
      tally(usages, t.to_place, entry);
    }
    for (const t of trips) {
      // trip_request stores no per-leg km, so a trip endpoint is counted but never given a
      // distance. Under-reporting is the honest direction here: a km we cannot attribute to a
      // leg would be a guess, and a guess is the thing this whole file is about.
      for (const stop of t.stops ?? []) {
        tally(usages, stop, {
          reference: t.reference,
          status: t.status,
          km: null,
          pair: (t.stops ?? []).join(' -> '),
        });
      }
    }

    console.log('## Free-text endpoints used in real bookings\n');
    if (usages.size === 0) {
      console.log('None. Every endpoint in every booking is a catalogue town, so no booking has');
      console.log('ever been priced on a string Google was free to interpret.\n');
    } else {
      const ranked = [...usages.values()].sort((a, b) => b.bookings.length - a.bookings.length);
      console.log('| endpoint | our place, said differently? | bookings | km priced | example |');
      console.log('| --- | --- | ---: | --- | --- |');
      for (const u of ranked) {
        const kms = u.bookings.map((b) => b.km).filter((k): k is number => k != null);
        // No km at all means every use was a trip stop (trip_request stores none) or a transfer
        // whose lookup failed. Saying "not stored" for a failed lookup would hide a second bug,
        // so the two are named apart.
        const span = kms.length
          ? kms.length > 1 && Math.min(...kms) !== Math.max(...kms)
            ? `${Math.min(...kms)}-${Math.max(...kms)}`
            : `${kms[0]}`
          : u.bookings.every((b) => b.km === null && b.pair.includes(' -> ') && !transferRefs.has(b.reference))
            ? '(trip stop -- no per-leg km stored)'
            : '(no distance recorded)';
        console.log(
          `| ${u.label} | ${nearCatalogue(u.label) ? 'yes' : 'NO -- read this one'} | ${u.bookings.length} | ${span} | ${u.bookings[0].reference} |`,
        );
      }
      console.log('');
      console.log('Read this list for words that name a CATEGORY rather than a place -- "airport",');
      console.log('"beach", "station", a bare town name that exists twice. A hotel or a landmark is');
      console.log('working as intended; those are what the Google lookup is there for.\n');
    }

    // ── Section 2: the floor guard, applied backwards over history ──────────────────────────
    // The one check that needs no judgement. Where BOTH endpoints resolve to catalogue
    // coordinates we hold an independent lower bound, so a stored distance below the straight
    // line between them was wrong when it was charged.
    console.log('## Priced below the straight-line floor\n');
    const breaches = transfers.filter((t) => {
      if (t.distance_km == null) return false;
      const a = knownCoords(t.from_place);
      const b = knownCoords(t.to_place);
      if (!a || !b) return false;
      return t.distance_km < haversineKm(a, b) * FLOOR_RATIO;
    });
    if (breaches.length === 0) {
      console.log('None -- every booking between two identified places was charged at or above the');
      console.log('straight line between them.\n');
    } else {
      console.log('| booking | route | charged km | straight line |');
      console.log('| --- | --- | ---: | ---: |');
      for (const t of breaches) {
        const crow = Math.round(
          haversineKm(knownCoords(t.from_place)!, knownCoords(t.to_place)!),
        );
        console.log(
          `| ${t.reference} (${t.status}) | ${t.from_place} -> ${t.to_place} | ${t.distance_km} | ${crow} |`,
        );
      }
      console.log('');
    }

    // ── Verdict ─────────────────────────────────────────────────────────────────────────────
    const paid = new Set(['paid', 'confirmed', 'in_progress', 'completed']);
    const chargedFreeText = [...usages.values()].flatMap((u) =>
      u.bookings.filter((b) => paid.has(b.status)),
    ).length;
    console.log('## Verdict\n');
    console.log(`Distinct free-text endpoints: ${usages.size}`);
    console.log(`Free-text endpoint uses on bookings that took money: ${chargedFreeText}`);
    console.log(`Bookings charged below the straight-line floor: ${breaches.length}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
