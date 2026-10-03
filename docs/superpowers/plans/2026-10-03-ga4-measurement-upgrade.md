# Route & Revenue Measurement Implementation Plan (rev 3: Phase 5 superseded)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "which routes earn the money" exactly from the database first. Then make WhatsApp-sold revenue visible as WhatsApp in GA4. Only after that, send privacy-safe route details with GA4 `purchase`, so GA4 can answer the one thing the database can't: which marketing channel brings which route.

**Architecture:** One server-side module, `knownPlace()`, turns any stored place string into a **known town + region + place type**, or `Other`. It reuses `KNOWN_PLACES` and the hot-zone rule of whole-token matching. A saved SQL report uses the same alias table, and a parity test pins the two together. Phase 5 computes GA4 trip facts once on the server from `knownPlace()`, returns them on the two customer views, and the two pages copy them into `purchase`. No address-parsing code runs in the browser.

**Tech Stack:**
- API: Node 20, TypeScript, Hono, Vitest (`api/`).
- Pages: plain browser JS (`analytics.js`, inline scripts in `manage.html` / `pay.html`).
- Web tests: Vitest + jsdom (`web-tests/unit/`), Playwright (`web-tests/e2e/`).
- Postgres (Supabase SQL editor).
- GTM container GTM-NL6K22CM (live v24); GA4 property p482905591.

**Why this order (critique of rev 1, 2026-10-03):**
1. The database already holds every route field exactly, for every booking including WhatsApp. GA4 sees about 5 purchases a week.
2. Rev 1's browser-side town rule passed text without commas straight through. A typed home address would have reached GA4.
3. The double-purchase risk raised in that critique was **checked and dropped**: `manage.html` takes payment only while unpaid (`payable()` needs `draft`/`payment_pending`, `manage.html:257`), and no online balance-payment path exists (`bookings.ts:199` and `opsNotifications.ts:344` only *display* the balance). The real effect is narrower: GA4 revenue for a deposit booking is just the deposit. The Phase 2 report measures that.

**Evidence base (all read 2026-10-03, `origin/main` @ 2487fab9 unless noted):**
- `purchase` is sent from `manage.html:161-174` and `pay.html:280-292` only. `booking.js:3341` is unreachable in production.
- The live GTM purchase tag forwards `transaction_id, value, currency, payment_type` only (published v24).
- GA4 admin: event data retention **2 months**; no BigQuery link; 14 event-scoped custom dimensions.
- Ops "Recently booked" (2026-10-02): about 33 of 55 paid bookings since 1 Sep were WhatsApp. GA4 matched 5 of 7 paid bookings since 28 Sep.
- `KNOWN_PLACES` = 38 towns (`api/src/adapters/maps.ts:126-136`). Whole-token matching: `api/src/quote/hotZones.ts:54-61`.
- Pay-link length is pinned under 100 characters on purpose: `api/src/routes/internalQuote.test.ts:2520-2522`.

## Global Constraints

- **No personal data in GA4:** no name, email, phone, street address, typed free text, or token. Place fields carry **only** a `KNOWN_PLACES` display name, a region from `REGION_OF`, or the literal `Other`.
- **Region names** (owner may rename before Task 2; the code and the SQL must match): `Airport & Negombo`, `Colombo`, `South coast`, `Hill country`, `Cultural triangle`, `Safari south`, `East coast`, `North & west`, plus `Other` for unmatched.
- **Place type values:** `airport` | `town` (the whole string is a known place) | `address` (a known town found inside an address) | `unknown`.
- **Airport rule:** `/airport|cmb|katunayake/i`, identical to `AIRPORT_RE` in `api/src/quote/payPageCopy.ts`. Any match maps to `Colombo Airport (CMB)`.
- **The visible pay/quote link is never lengthened** (owner rule). UTMs go only on the short-link redirect target.
- **GA4 `purchase` parameter names (exact):** `service_type`, `pickup`, `pickup_region`, `pickup_type`, `dropoff`, `dropoff_region`, `dropoff_type`, `route`, `region_route`, `pax`, `vehicle_type`, `booking_total`, `coupon`, `discount`, `travel_month`, `days_to_travel`. No other event pushes these keys today.
- **`value` keeps its meaning:** the amount charged now. `booking_total` = the whole booking.
- **No schema, migration, pricing or config changes in this plan.** Tasks 8-9 add a field to two public JSON responses. That is an interface change and needs the owner's OK first (CLAUDE.md hard rule 5).
- **Gates:**
  - Before each commit: the suites that cover the change pass.
  - Before each PR: `npm --prefix <worktree>/web-tests run test:all` and `cd api && npm run check`. Both must be green, judged by the runner's own summary line and exit code, never read through a pipe.

## Working environment (read once)

- **Worktree:** `/Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-measurement-plan` (from `origin/main` @ 2487fab9). Each PR gets its own branch, created from the current `origin/main` when its phase starts.
- **Git:** `/usr/bin/git` is blocked by the Xcode licence: `GIT=/Library/Developer/CommandLineTools/usr/bin/git`. Run `gh … --repo ceylonhop/ceylon-hop`.
- **Shell chains:** start every chain with `cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-measurement-plan || exit 1`.
- **Staging:** stage by path only, never `git add -A`.
- **Releases:**
  - `main` → staging API.
  - Site (Pages) and prod API both deploy from `production`, via a promote PR the **owner** merges.
  - GTM is live on publish.

## File map

| File | Change | Task |
|---|---|---|
| `api/src/services/analytics/knownPlace.ts` | **new**: `ALIASES`, `REGION_OF`, `knownPlace()` | 2 |
| `api/src/services/analytics/knownPlace.test.ts` | **new**: cases, coverage, SQL parity | 2, 3 |
| `docs/analytics/route-report.sql` | **new**: the saved route report | 3 |
| `api/src/routes/customerShortLink.ts` | UTMs on redirect targets | 5 |
| `api/src/routes/customerShortLink.test.ts` | UTM assertions | 5 |
| `api/src/services/analytics/purchaseFacts.ts` | **new**: `purchaseFacts()`, `quotePurchaseFacts()` | 7 |
| `api/src/services/analytics/purchaseFacts.test.ts` | **new** | 7 |
| `api/src/routes/bookings.ts` | `CustomerBookingView.analytics` | 8 |
| `api/src/routes/bookingView.test.ts` | new case | 8 |
| `api/src/routes/quotePay.ts` / `quotePay.test.ts` | pay view `analytics` | 9 |
| `analytics.js` | `window.chPurchaseDetails()` | 10 |
| `web-tests/unit/analytics-purchase-details.test.js` | **new** | 10 |
| `manage.html`, `web-tests/unit/manage-purchase-sandbox.test.js` | purchase carries details | 10 |
| `pay.html`, `web-tests/e2e/property-analytics.spec.js` | stash + purchase details | 10 |
| `tools/analytics/build-gtm-funnel-tags.mjs`, `docs/analytics/gtm-funnel-tags.json`, `web-tests/unit/gtm-funnel-tags.test.js`, `docs/analytics/property-tracking.md` | GTM params + docs | 11 |

---

## Phase 1: GA4 retention (owner, minutes, no code)

### Task 1: Raise event-data retention to 14 months

- [ ] **Step 1:** GA4 → Admin → Data collection and modification → **Data retention** → Event data retention **2 months → 14 months** → Save. It was verified at 2 months on 2026-10-03. It is not retroactive and takes effect after about 24h.
- [ ] **Step 2:** Reload the page and confirm it reads "14 months".

---

## Phase 2: best routes from the database (exact, every booking, today)

### Task 2: `knownPlace()`: known town, region and place type from any stored place

> **GATE:** the owner confirms or renames the 8 regions in Global Constraints before Step 3.

**Files:**
- Create: `api/src/services/analytics/knownPlace.ts`
- Create: `api/src/services/analytics/knownPlace.test.ts`

**Interfaces:**
- Produces:
  - `knownPlace(place: string | null | undefined): KnownPlace`
  - `KnownPlace = { town: string; region: string; type: 'airport' | 'town' | 'address' | 'unknown' }`
  - Exported `ALIASES: readonly (readonly [alias: string, town: string])[]` and `REGION_OF: Readonly<Record<string, string>>`
- Consumed by Tasks 3 and 7.

- [ ] **Step 1: Write the failing test.** Create `api/src/services/analytics/knownPlace.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { KNOWN_PLACES } from '../../adapters/maps';
import { ALIASES, REGION_OF, knownPlace } from './knownPlace';

// The ONE place→town rule for reporting (2026-10-03). A stored place is free text or a Google
// label; reports need a known TOWN and REGION, and anything we can't name must read "Other",
// never the raw string, because a typed home address is personal data (and GA4 noise).

describe('knownPlace', () => {
  it.each([
    ['Colombo Airport (CMB)', { town: 'Colombo Airport (CMB)', region: 'Airport & Negombo', type: 'airport' }],
    ['Bandaranaike International Airport, Katunayake, Sri Lanka', { town: 'Colombo Airport (CMB)', region: 'Airport & Negombo', type: 'airport' }],
    ['Ella', { town: 'Ella', region: 'Hill country', type: 'town' }],
    ['Sigiriya', { town: 'Sigiriya / Dambulla', region: 'Cultural triangle', type: 'town' }],
    ['Granbell Hotel Colombo, Marine Drive, Colombo, Sri Lanka', { town: 'Colombo City', region: 'Colombo', type: 'address' }],
    ['84/2/A, Poruthota Road, Ethukale, Negombo, 11500 Negombo, Sri Lanka', { town: 'Negombo', region: 'Airport & Negombo', type: 'address' }],
    ['Ella town, ඇල්ල නගරය, Police Station Road, Ella, Sri Lanka', { town: 'Ella', region: 'Hill country', type: 'address' }],
    ['Lighthouse Hotel, Colombo 03, Sri Lanka', { town: 'Colombo City', region: 'Colombo', type: 'address' }],
    ['Galle Face Green, Colombo, Sri Lanka', { town: 'Colombo City', region: 'Colombo', type: 'address' }],
  ])('%j', (place, want) => {
    expect(knownPlace(place)).toEqual(want);
  });

  it('matches whole tokens only — "Bella Vista" is not Ella', () => {
    expect(knownPlace('Bella Vista, Ratnapura, Sri Lanka')).toEqual({ town: 'Other', region: 'Other', type: 'unknown' });
  });

  it('never returns typed free text — an unknown place is "Other"', () => {
    for (const s of ['No 12 Temple Road Matara', 'my villa near the lighthouse', '', null, undefined]) {
      expect(knownPlace(s)).toEqual({ town: 'Other', region: 'Other', type: 'unknown' });
    }
  });

  it('covers every KNOWN_PLACES town with an alias and a region', () => {
    const aliased = new Set(ALIASES.map(([, town]) => town));
    for (const town of KNOWN_PLACES) {
      expect(aliased.has(town), `alias for ${town}`).toBe(true);
      expect(REGION_OF[town], `region for ${town}`).toBeTruthy();
    }
  });

  it('every alias is lower-case and points at a known town', () => {
    for (const [alias, town] of ALIASES) {
      expect(alias).toBe(alias.toLowerCase().trim());
      expect(KNOWN_PLACES).toContain(town);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
  - Run: `cd api && npx vitest run src/services/analytics/knownPlace.test.ts`
  - Expected: FAIL, `Cannot find module './knownPlace'`.

- [ ] **Step 3: Implement.** Create `api/src/services/analytics/knownPlace.ts`:

```ts
// The ONE place→town rule for reporting (2026-10-03): route report SQL (docs/analytics/
// route-report.sql, pinned to ALIASES by knownPlace.test.ts) and GA4 purchase facts.
//
// Stored places are free text or Google labels. The town is found by WHOLE-token equality
// against known aliases (the hot-zone rule, hotZones.ts endpointTokens: "Bella Vista" never
// matches "Ella"), trying the whole string first, then each comma component from the END,
// because a Google label ends in its town. Anything unmatched is "Other" — never the raw
// string: a typed home address is personal data.

import { KNOWN_PLACES } from '../../adapters/maps';

export interface KnownPlace {
  town: string;
  region: string;
  type: 'airport' | 'town' | 'address' | 'unknown';
}

const AIRPORT = 'Colombo Airport (CMB)';
// Same test as payPageCopy.ts AIRPORT_RE and the ops shell's airport flag.
const AIRPORT_RE = /airport|cmb|katunayake/i;

export const REGION_OF: Readonly<Record<string, string>> = {
  'Colombo Airport (CMB)': 'Airport & Negombo', Negombo: 'Airport & Negombo',
  'Colombo City': 'Colombo',
  Bentota: 'South coast', Hikkaduwa: 'South coast', Galle: 'South coast', Unawatuna: 'South coast',
  Ahangama: 'South coast', Weligama: 'South coast', Mirissa: 'South coast', Hiriketiya: 'South coast',
  Tangalle: 'South coast',
  Kandy: 'Hill country', 'Nuwara Eliya': 'Hill country', Ella: 'Hill country', 'Nanu Oya': 'Hill country',
  Hatton: 'Hill country', "Adam's Peak": 'Hill country', Haputale: 'Hill country',
  'Horton Plains': 'Hill country', Kitulgala: 'Hill country',
  'Sigiriya / Dambulla': 'Cultural triangle', Dambulla: 'Cultural triangle', Habarana: 'Cultural triangle',
  Polonnaruwa: 'Cultural triangle', Anuradhapura: 'Cultural triangle', Thanthirimale: 'Cultural triangle',
  Yala: 'Safari south', Tissamaharama: 'Safari south', Udawalawe: 'Safari south',
  'Arugam Bay': 'East coast', Trincomalee: 'East coast', 'Nilaveli Beach': 'East coast', Nilaveli: 'East coast',
  Pasikudah: 'East coast',
  Jaffna: 'North & west', Wilpattu: 'North & west', Kalpitiya: 'North & west',
};

// Every alias → its KNOWN_PLACES display name. Lower-case, whitespace-collapsed. Kept explicit
// (not derived) so the SQL report can carry the identical table (parity-tested).
export const ALIASES: readonly (readonly [string, string])[] = [
  ["adam's peak", "Adam's Peak"], ['ahangama', 'Ahangama'], ['anuradhapura', 'Anuradhapura'],
  ['arugam bay', 'Arugam Bay'], ['bentota', 'Bentota'],
  ['colombo airport (cmb)', 'Colombo Airport (CMB)'], ['colombo airport', 'Colombo Airport (CMB)'],
  ['colombo city', 'Colombo City'], ['colombo', 'Colombo City'],
  ['dambulla', 'Dambulla'], ['ella', 'Ella'], ['galle', 'Galle'], ['habarana', 'Habarana'],
  ['haputale', 'Haputale'], ['hatton', 'Hatton'], ['hikkaduwa', 'Hikkaduwa'], ['hiriketiya', 'Hiriketiya'],
  ['horton plains', 'Horton Plains'], ['jaffna', 'Jaffna'], ['kalpitiya', 'Kalpitiya'], ['kandy', 'Kandy'],
  ['kitulgala', 'Kitulgala'], ['mirissa', 'Mirissa'], ['nanu oya', 'Nanu Oya'], ['negombo', 'Negombo'],
  ['nilaveli beach', 'Nilaveli Beach'], ['nilaveli', 'Nilaveli'], ['nuwara eliya', 'Nuwara Eliya'],
  ['pasikudah', 'Pasikudah'], ['polonnaruwa', 'Polonnaruwa'],
  ['sigiriya / dambulla', 'Sigiriya / Dambulla'], ['sigiriya', 'Sigiriya / Dambulla'],
  ['tangalle', 'Tangalle'], ['thanthirimale', 'Thanthirimale'], ['tissamaharama', 'Tissamaharama'],
  ['trincomalee', 'Trincomalee'], ['udawalawe', 'Udawalawe'], ['unawatuna', 'Unawatuna'],
  ['weligama', 'Weligama'], ['wilpattu', 'Wilpattu'], ['yala', 'Yala'],
];

const BY_ALIAS = new Map(ALIASES);
const OTHER: KnownPlace = { town: 'Other', region: 'Other', type: 'unknown' };

// The SQL report applies the same four steps (route-report.sql, CTE `tok`).
function token(part: string): string {
  return part.trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/,?\s*sri lanka$/, '')
    .replace(/^\d{4,6}\s+|\s+\d{4,6}$/g, '')
    .replace(/^colombo\s+\d{1,2}$/, 'colombo')
    .trim();
}

export function knownPlace(place: string | null | undefined): KnownPlace {
  const s = String(place ?? '').trim();
  if (!s) return OTHER;
  if (AIRPORT_RE.test(s)) return { town: AIRPORT, region: REGION_OF[AIRPORT], type: 'airport' };
  const whole = BY_ALIAS.get(token(s));
  if (whole) return { town: whole, region: REGION_OF[whole] ?? 'Other', type: 'town' };
  const parts = s.split(',').map(token).filter(Boolean).reverse();
  for (const t of parts) {
    const town = BY_ALIAS.get(t);
    if (town) return { town, region: REGION_OF[town] ?? 'Other', type: 'address' };
  }
  return OTHER;
}
```

- [ ] **Step 4: Run the test.**
  - Run: `cd api && npx vitest run src/services/analytics/knownPlace.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit** on branch `feat/route-report` (`$GIT switch -c feat/route-report origin/main` first):

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-measurement-plan || exit 1
$GIT add api/src/services/analytics/knownPlace.ts api/src/services/analytics/knownPlace.test.ts
$GIT commit -m "feat(analytics): knownPlace — known town, region and place type for reporting"
```

### Task 3: The saved route report (SQL) + parity with `ALIASES`

**Files:**
- Create: `docs/analytics/route-report.sql`
- Modify: `api/src/services/analytics/knownPlace.test.ts` (parity test)

**Interfaces:**
- Consumes: `ALIASES` and `REGION_OF` (Task 2). The SQL `alias` VALUES must equal `ALIASES` joined with `REGION_OF`, row for row.

- [ ] **Step 1: Write the failing parity test.** Append to `knownPlace.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The route report runs in the Supabase SQL editor, so it carries its own copy of the alias
// table. This pins it to ALIASES/REGION_OF: change one, the other must follow.
describe('docs/analytics/route-report.sql', () => {
  const sql = readFileSync(join(import.meta.dirname, '../../../../docs/analytics/route-report.sql'), 'utf8');
  const un = (s: string) => s.replace(/''/g, "'");
  const rows = [...sql.matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)]
    .map((m) => [un(m[1]), un(m[2]), un(m[3])]);

  it('carries exactly the ALIASES table, with REGION_OF regions', () => {
    const want = ALIASES.map(([alias, town]) => [alias, town, REGION_OF[town]]);
    expect(rows).toEqual(want);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
  - Run: `cd api && npx vitest run src/services/analytics/knownPlace.test.ts`
  - Expected: FAIL with `ENOENT … route-report.sql`.

- [ ] **Step 3: Create `docs/analytics/route-report.sql`:**

```sql
-- Route report (2026-10-03): paid bookings by known town → known town, and by region.
-- Read-only. Run in the Supabase SQL editor. Same place rule as
-- api/src/services/analytics/knownPlace.ts (the alias table below is parity-tested against it).
-- Excludes the owner's test bookings, cancelled and refunded ones, and anything never paid.
-- `collected_usd` = money taken online; `booked_value_usd` = booking totals. The gap is
-- deposits still owed (`deposit_bookings`), which GA4 also never sees as revenue.
with alias(alias, town, region) as (values
  ('adam''s peak', 'Adam''s Peak', 'Hill country'),
  ('ahangama', 'Ahangama', 'South coast'),
  ('anuradhapura', 'Anuradhapura', 'Cultural triangle'),
  ('arugam bay', 'Arugam Bay', 'East coast'),
  ('bentota', 'Bentota', 'South coast'),
  ('colombo airport (cmb)', 'Colombo Airport (CMB)', 'Airport & Negombo'),
  ('colombo airport', 'Colombo Airport (CMB)', 'Airport & Negombo'),
  ('colombo city', 'Colombo City', 'Colombo'),
  ('colombo', 'Colombo City', 'Colombo'),
  ('dambulla', 'Dambulla', 'Cultural triangle'),
  ('ella', 'Ella', 'Hill country'),
  ('galle', 'Galle', 'South coast'),
  ('habarana', 'Habarana', 'Cultural triangle'),
  ('haputale', 'Haputale', 'Hill country'),
  ('hatton', 'Hatton', 'Hill country'),
  ('hikkaduwa', 'Hikkaduwa', 'South coast'),
  ('hiriketiya', 'Hiriketiya', 'South coast'),
  ('horton plains', 'Horton Plains', 'Hill country'),
  ('jaffna', 'Jaffna', 'North & west'),
  ('kalpitiya', 'Kalpitiya', 'North & west'),
  ('kandy', 'Kandy', 'Hill country'),
  ('kitulgala', 'Kitulgala', 'Hill country'),
  ('mirissa', 'Mirissa', 'South coast'),
  ('nanu oya', 'Nanu Oya', 'Hill country'),
  ('negombo', 'Negombo', 'Airport & Negombo'),
  ('nilaveli beach', 'Nilaveli Beach', 'East coast'),
  ('nilaveli', 'Nilaveli', 'East coast'),
  ('nuwara eliya', 'Nuwara Eliya', 'Hill country'),
  ('pasikudah', 'Pasikudah', 'East coast'),
  ('polonnaruwa', 'Polonnaruwa', 'Cultural triangle'),
  ('sigiriya / dambulla', 'Sigiriya / Dambulla', 'Cultural triangle'),
  ('sigiriya', 'Sigiriya / Dambulla', 'Cultural triangle'),
  ('tangalle', 'Tangalle', 'South coast'),
  ('thanthirimale', 'Thanthirimale', 'Cultural triangle'),
  ('tissamaharama', 'Tissamaharama', 'Safari south'),
  ('trincomalee', 'Trincomalee', 'East coast'),
  ('udawalawe', 'Udawalawe', 'Safari south'),
  ('unawatuna', 'Unawatuna', 'South coast'),
  ('weligama', 'Weligama', 'South coast'),
  ('wilpattu', 'Wilpattu', 'North & west'),
  ('yala', 'Yala', 'Safari south')
),
booking as (
  select
    b.id, b.reference, b.mode, b.channel, b.created_at, b.total,
    coalesce(b.amount_due_now, b.total) as due_now,
    coalesce(
      (select bl.from_place from booking_legs bl
        where bl.booking_id = b.id and bl.removed_at is null order by bl.seq asc limit 1),
      tr.from_place, sr.from_place, co.from_place) as pickup_text,
    coalesce(
      (select bl.to_place from booking_legs bl
        where bl.booking_id = b.id and bl.removed_at is null order by bl.seq desc limit 1),
      tr.to_place, sr.to_place, co.to_place) as dropoff_text
  from bookings b
  join customers c              on c.id = b.customer_id
  left join transfer_request tr on tr.booking_id = b.id
  left join shared_request  sr  on sr.booking_id = b.id
  left join corridor        co  on co.id = sr.corridor_id
  where b.created_at >= date '2026-09-01'                     -- change the start date here
    and b.status not in ('cancelled', 'refunded')
    and lower(btrim(c.email)) not in ('roshenw@gmail.com', 'roshen@ceylonhop.com')
    and exists (select 1 from payments p where p.booking_id = b.id and p.status = 'succeeded')
),
ends as (
  select id, 'pickup' as side, coalesce(pickup_text, '') as place from booking
  union all
  select id, 'dropoff', coalesce(dropoff_text, '') from booking
),
tok as (   -- knownPlace.ts token(): whole string (priority highest), then comma parts, later = higher
  select e.id, e.side, s.prio,
    btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      lower(btrim(s.part)), '\s+', ' ', 'g'),
      ',?\s*sri lanka$', ''),
      '^\d{4,6}\s+|\s+\d{4,6}$', '', 'g'),
      '^colombo\s+\d{1,2}$', 'colombo')) as token,
    (s.prio = 1000000) as whole
  from ends e
  cross join lateral (
    select e.place as part, 1000000 as prio
    union all
    select x.p, x.ord::int from regexp_split_to_table(e.place, ',') with ordinality as x(p, ord)
  ) s
),
matched as (
  select distinct on (t.id, t.side) t.id, t.side, a.town, a.region, t.whole
  from tok t join alias a on a.alias = t.token
  order by t.id, t.side, t.prio desc
),
place as (
  select e.id, e.side,
    case when e.place ~* '(airport|cmb|katunayake)' then 'Colombo Airport (CMB)' else coalesce(m.town, 'Other') end as town,
    case when e.place ~* '(airport|cmb|katunayake)' then 'Airport & Negombo' else coalesce(m.region, 'Other') end as region
  from ends e
  left join matched m on m.id = e.id and m.side = e.side
),
money as (
  select bk.id,
    coalesce((select sum(p.amount) from payments p
               where p.booking_id = bk.id and p.status = 'succeeded'), 0)
  - coalesce((select sum(f.amount_cents) from refunds f
               where f.booking_id = bk.id and f.status in ('manual_confirmed', 'api_confirmed')), 0)
      as collected_cents
  from booking bk
)
select
  p1.town   || ' → ' || p2.town   as route,
  p1.region || ' → ' || p2.region as region_route,
  count(*)                                              as bookings,
  count(*) filter (where bk.mode = 'single')            as transfers,
  count(*) filter (where bk.mode = 'shared')            as shared_seats,
  count(*) filter (where bk.mode = 'trip')              as trips,
  count(*) filter (where bk.channel = 'website')        as website,
  count(*) filter (where bk.channel = 'whatsapp')       as whatsapp,
  count(*) filter (where bk.due_now < bk.total)         as deposit_bookings,
  round(sum(m.collected_cents) / 100.0, 2)              as collected_usd,
  round(sum(bk.total) / 100.0, 2)                       as booked_value_usd,
  round(avg(bk.total) / 100.0, 2)                       as avg_booking_usd,
  string_agg(bk.reference, ', ' order by bk.created_at desc) as refs
from booking bk
join place p1 on p1.id = bk.id and p1.side = 'pickup'
join place p2 on p2.id = bk.id and p2.side = 'dropoff'
join money m  on m.id  = bk.id
group by 1, 2
order by booked_value_usd desc, bookings desc;
```

- [ ] **Step 4: Run the tests and the API gate.**
  - Run: `cd api && npx vitest run src/services/analytics/knownPlace.test.ts && npm run check`
  - Expected: PASS (parity included), and `check` exits 0.

- [ ] **Step 5: Commit, PR, merge.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-measurement-plan || exit 1
$GIT add docs/analytics/route-report.sql api/src/services/analytics/knownPlace.test.ts
$GIT commit -m "docs(analytics): saved route report — known towns and regions, parity-tested"
```

  Then `gh pr create --repo ceylonhop/ceylon-hop` (PR 1 = Tasks 2-3). This PR changes no runtime behaviour, so no promote is needed for the report itself.

---

## Phase 3: the deposit check (owner runs the report, no code)

### Task 4: Run the report and record the findings

- [ ] **Step 1:** The owner pastes `docs/analytics/route-report.sql` into the Supabase SQL editor and runs it. It is read-only, and production reads are the owner's to run.
- [ ] **Step 2:** Record, in the PR 1 thread or `docs/analytics/route-report-findings-2026-10.md`:
  - the top 10 `route` rows by `booked_value_usd`;
  - total `deposit_bookings`, and Σ`booked_value_usd` − Σ`collected_usd`;
  - how many rows have `Other` on either side.
- [ ] **Step 3: Decide.**
  - **If `Other` is above about 10% of bookings:** list the unmatched towns.
    - A town that is already a `KNOWN_PLACES` entry under another spelling needs one alias row in `ALIASES` and in the SQL `alias` VALUES.
    - A new town needs a `KNOWN_PLACES` entry, an `ALIASES` row, a `REGION_OF` row and the SQL row.
    - The coverage and parity tests force all of these to change together.
  - **If deposits are a material share of booked value:** Phase 5's `booking_total` covers GA4. A server-side balance/settlement event is roadmap R2.

---

## Phase 4: WhatsApp attribution

### Task 5: UTMs on the short-link redirect target (invisible to the customer)

> **Precondition (owner, one check):** short links are on in prod. Either the Render env `CUSTOMER_SHORT_LINKS_ENABLED` is `true`, or a pay link minted today reads `pay.ceylonhop.com/s/…`. If they are off, this task changes nothing a customer sees, so turn them on first; that is a config change, so it's the owner's call.

**Files:**
- Modify: `api/src/routes/customerShortLink.ts` (the two success redirects, currently lines 60 and 68)
- Test: `api/src/routes/customerShortLink.test.ts`

**Interfaces:**
- Produces: redirect `Location`s that keep `t` and add `utm_source=whatsapp`, `utm_medium=quote_link` or `pay_link`, and `utm_campaign=ops_quote`. The `invalid`-token fallbacks (lines 44-45) stay untouched.

- [ ] **Step 1: Failing test.** In `customerShortLink.test.ts`, add inside the `describe`:

```ts
  it('tags the redirect target as WhatsApp traffic — the link the customer sees stays short', async () => {
    const quote = await seeded({ kind: 'quote_view', quoteId: QUOTE_ID });
    const q = new URL((await quote.app.request(`https://quote.example/s/${quote.code}`)).headers.get('location')!);
    expect(Object.fromEntries([...q.searchParams].filter(([k]) => k.startsWith('utm_'))))
      .toEqual({ utm_source: 'whatsapp', utm_medium: 'quote_link', utm_campaign: 'ops_quote' });

    const pay = await seeded({ kind: 'quote_pay', quoteId: QUOTE_ID, revision: 7, seq: 3 });
    const p = new URL((await pay.app.request(`https://pay.example/s/${pay.code}`)).headers.get('location')!);
    expect(p.searchParams.get('utm_medium')).toBe('pay_link');
    expect(verifyQuotePayToken(p.searchParams.get('t') ?? undefined, SECRET)).toEqual({ quoteId: QUOTE_ID, revision: 7, seq: 3 });
  });
```

- [ ] **Step 2: Run and watch it fail.**
  - Run: `cd api && npx vitest run src/routes/customerShortLink.test.ts`
  - Expected: FAIL. The utm entries are `{}`.

- [ ] **Step 3: Implement.** In `customerShortLink.ts`, add above `r.get('/:code', …)`:

```ts
  // Attribution (2026-10-03): short links are sent in WhatsApp threads by ops, and the in-app
  // browser sends no referrer, so GA4 filed every paying session as "direct". Tag the TARGET
  // here, never the link the customer reads (a short link reads less like phishing: owner rule,
  // internalQuote.test.ts pins the long link under 100 chars).
  const UTM = (medium: 'quote_link' | 'pay_link') =>
    `&utm_source=whatsapp&utm_medium=${medium}&utm_campaign=ops_quote`;
```

  and change the two success redirects to:

```ts
        return c.redirect(`${quoteBase}/q?t=${encodeURIComponent(token)}${UTM('quote_link')}`, 302);
```

```ts
      return c.redirect(`${payBase}/p?t=${encodeURIComponent(token)}${UTM('pay_link')}`, 302);
```

- [ ] **Step 4: Run.**
  - `cd api && npx vitest run src/routes/customerShortLink.test.ts && npm run check`. Expected: PASS, exit 0.
  - Also run `npm --prefix …/web-tests run test:all`. `pay.html`/`quote.html` must tolerate extra query params; it is expected green.

- [ ] **Step 5: Commit, PR 2, release.**

```bash
cd /Users/roshenw/claude_code/ceylon-hop/.claude/worktrees/ga4-measurement-plan || exit 1
$GIT add api/src/routes/customerShortLink.ts api/src/routes/customerShortLink.test.ts
$GIT commit -m "feat(attribution): tag short-link redirect targets as WhatsApp traffic for GA4"
```

  Branch `feat/whatsapp-utm` from `origin/main`. After merge, the owner merges the promote PR. Then verify in GA4 → Reports → Acquisition (Traffic acquisition) that `whatsapp / pay_link` appears after the next paid WhatsApp booking.

### Task 6: Visit-code attribution (separate spec; schema decision)

The UTMs label the *paying* session as WhatsApp. They can't say which **website visit** (Google, Instagram, ChatGPT…) started the conversation. The fix:
- put a short visit code in the WhatsApp pre-fill (`booking.js:2054-2070`, `plan.js:1187-1203`, `search.js:130-139`, `analytics.js:157-165`);
- have ops paste or keep it on the quote;
- send it to GA4 with the purchase.

This needs a column on `quotes` (schema), so it gets its own brainstorm → spec → plan. **Not part of this plan's tasks.**

---

## Phase 5: GA4 purchase details (SUPERSEDED, 2026-10-03)

Replaced by the owner-approved server-side design:
- spec: `docs/superpowers/specs/2026-10-03-server-side-ga4-purchase-design.md`
- plan: `docs/superpowers/plans/2026-10-03-server-side-ga4-purchase.md`

The server now reports every settled payment and refund to GA4 itself, with the sale details. The browser-side tasks 7-11 that used to be here are dropped. Their `purchaseFacts()` moved to that plan's Task 1. Phases 1-4 above are unchanged and still come first. Phase 2's `knownPlace()` is that plan's prerequisite.

---

## Roadmap (separate plans; each needs the owner's call)

| # | Plan | Why | Owner decision |
|---|---|---|---|
| R1b | Visit-code attribution (Task 6) | Which website visit started each WhatsApp sale | Column on `quotes` (schema) |
| R2 | Server-side purchase + refund via the GA4 Measurement Protocol (PayHere webhook; `afterRefundConfirmed`, `api/src/routes/admin.ts:247-298`) | Catches closed tabs and the `manage.html` minimal-paid path; net revenue; balances; booking country; channel | GA4 API secret (config); GA client id stored at checkout (schema) |
| R3 | `generate_lead` with quoted value; key events `contact_whatsapp`, `quote_link_opened` | Quote → paid rate per channel | — |
| R4 | Audiences (priced not booked; checkout failed; exclude past bookers) to Google Ads/Meta | Remarketing | Ad spend; consent |
| R5 | `content_group` in `analytics.js` | Do guides lead to bookings? | — |
| R6 | BigQuery daily export | Join GA4 visits to bookings by reference | New Google Cloud project (service + billing) |
| — | Funnel exploration (search → select_item → begin_checkout → payment_initiated → purchase) | Already scheduled for 2026-10-26 | — |

## Known limits

- **Accuracy is bounded by `KNOWN_PLACES` (38 towns).** Anything else is `Other`, by design, for privacy. Phase 3 Step 3 measures how much falls there, and adding aliases is a parity-tested two-line change.
- **The airport rule maps any "airport/cmb/katunayake" mention to CMB.** A Mattala airport booking would be mislabelled. None are known so far.
- **Pay-link facts describe the whole quote, not the paid subset of legs.** `days_to_travel` counts whole UTC days.
- **GA4 still sees only purchases that return to the site.** Closed tabs and the minimal-paid path are R2.
