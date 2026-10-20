# Customer place identity: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A place the customer picks from Google is priced, and driven to, as that exact place. A trip the server can't price never reaches a pay button. Ops hears about every unpriced booking.

**Architecture:**
- The browser sends Google's **place ID** next to each place name, as optional fields sent only when they have a value.
- The server resolves the ID to coordinates itself (Geocoding `place_id=`) and measures with `"lat,lng"`. That path already exists for the ops tool (`maps.ts` `parseLatLng`). The engine keeps receiving **names**, so hot zones, emails and analytics are untouched.
- The booking keeps the ID on `booking_legs`.

**Spec:** `docs/superpowers/specs/2026-10-18-customer-place-identity-design.md`. Section numbers (§) below refer to it.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle + Postgres · vanilla JS front-end · Playwright (`web-tests/`).

**Code read at:** `origin/main` `edf36f0b`. Line numbers are approximate (marked `~`): re-find them with `grep` before editing, because `main` moves under other sessions. `booking.js` has already changed since then (#1022, keep the date on reload), so its line references are the least reliable.

## Global Constraints

- **One task = one branch = one PR**, from a fresh worktree off `origin/main`. Multiple sessions share the main checkout, so stage files by path, never `git add -A`.
- **Maintenance mode:** before starting each task, post its file list and approach to the owner and wait for a go. **Task 7 carries a migration; Tasks 4a/4b change the `MapsAdapter` interface and public request schemas.** Name these in the proposal.
- **Additive only.** A new field is sent **only when it has a value**. A request with no Google pick must be byte-identical to today's: same idempotency key, intent signature, cache keys and fingerprints. Never rewrite, re-measure, backfill or re-geocode an existing booking, quote or stored name.
- **The engine receives names, never `"lat,lng"`.** Hot zones match by name only (`hotZones.ts:116`).
- **Never write to `place_resolutions` from a public path.** Read-only `repo.get()` only; never `PlaceResolver.resolve()`.
- **Never trust coordinates from the browser.** Only place IDs cross the wire; the server resolves them.
- **Release order:**
  - Task 4b is promoted to production **in its own promotion** before any of Tasks 5, 6 or 9 merge, because `WebQuoteIntentSchema` is `.strict()`.
  - Task 7's migration auto-applies on staging at merge and reaches prod only on the owner's promotion.
- **Gate before every commit:**
  - `cd api && npm run check`, with `DATABASE_URL_TEST` set to a **local** test DB (never `api/.env`, whose `DATABASE_URL` is prod).
  - `npm --prefix /Users/roshenw/claude_code/ceylon-hop/web-tests run test:all` (run from that directory, not via a pipe; read the runner's own summary line and exit code).
  - After editing any root asset (`*.js`/`*.html`/`site.css`), run `npm run stamp`.
- **Tests use the fake maps adapter and the Places stub.** No real Google calls in CI.
- **Red → green evidence** is pasted in every PR.

---

## File map

| File | Tasks | Change |
|---|---|---|
| `api/src/routes/bookings.ts` | 1, 4b, 7 | Ops alert on unpriced; place IDs into pricing and storage; leg identities into `bookings.create` |
| `api/src/services/opsNotifications.ts` (+test) | 1 | `teamUnpricedEmail` |
| `api/src/adapters/maps.ts` (+test) | 2, 4a | Floor guard on metres; `ResolvedPlace`; `placeById` on Google + fake |
| `api/src/adapters/meteredMaps.ts`, `cachedMaps.ts` (+tests) | 4a | Forward `placeById` |
| `api/src/routes/bookings.ts` `memoizeDistance` | 4a | Forward `placeById`, `geocode` |
| `api/src/quote/stopIdentity.ts` (+test) | 4b | **Create.** `identifyStops()` (§6) |
| `api/src/quote/webQuoteV2.ts` (+test) | 4b | `fromPlaceId?`/`toPlaceId?` on legs and days |
| `api/src/domain/trip.ts`, `domain/singleTransfer.ts` | 4b | `stopPlaceIds?`, `fromPlaceId?`/`toPlaceId?` |
| `api/src/services/pricing.ts` (+test) | 4b | Optional measure strings for `priceSingle`/`priceTrip` |
| `api/src/routes/quote.ts` (+test) | 4b | `engineRequestFor` identifies stops; 422 `unresolved` |
| `api/src/app.ts` | 4b | Pass `placeResolutions` + `usageMeter` to quote/booking routes |
| `ch-pricing.js`, `booking.js`, `booking.html` | 3, 5, 6 | 422 → honest state; send place IDs; `pids` |
| `ch-map.js` | 5 | `resolvePick` returns `placeId` and `area` |
| `plan.js`, `plan.html` | 5 | `pickedPlaces` map; `pids` in URLs; area line |
| `api/drizzle/0074_booking_leg_place_ids.sql`, `meta/_journal.json`, `api/src/db/schema.ts` | 7 | Two nullable columns |
| `api/src/domain/bookingLegs.ts` (+test), `api/src/db/postgresBookingRepo.ts`, `api/src/db/bookingRepo.ts` | 7 | Apply leg identities on insert |
| `api/src/routes/ops-ui.html`, ops booking view source | 8 | Show resolved place, Maps link, mismatch badge |
| `web-tests/e2e/_stubs.js`, new specs | 3, 5, 6 | Stub gains `id`; new e2e |

---

### Task 0: Live check that our server key resolves a front-end place ID (owner-assisted, no PR)

Why: Google documents geocoding by place ID, and IDs shared across the JS, Places and Geocoding APIs (spec §7, verified in docs). It has not been proven on **our** key with an ID from **our** picker. This takes two minutes, and Task 4a depends on it.

- [ ] **Step 1: Get a real ID from the live picker.** In the browser pane, open `https://ceylonhop.com/plan.html` and type `Casa Selvita` in a stop. With the dropdown open, run in the console:

```js
const s = await window.CH_MAP.suggest('Casa Selvita'); const p = s[0]._p.toPlace(); p.id
```

Expected: a string such as `ChIJ…`. Record it. (`suggest` is exported from `ch-map.js:678`; `toPlace()` is the call `resolvePick` already makes.)

- [ ] **Step 2: The owner resolves it with the server key.** Ask the owner to run this. The key is a Render env secret; don't read `api/.env`.

```bash
curl -s "https://maps.googleapis.com/maps/api/geocode/json?place_id=<ID>&key=<SERVER_KEY>" | jq '{status, r: .results[0] | {formatted_address, loc: .geometry.location}}'
```

Expected: `"status": "OK"`, with a location in Sri Lanka near Kandy (Casa Selvita priced at 87 km from EKHO Sigiriya on 2026-10-18).

- [ ] **Step 3: Record the result** in the spec, §7 ("Still to prove live"). If the status is `REQUEST_DENIED`, the server key's API restrictions exclude this use. **Stop and ask**: Task 4a would then need the key changed, a config/owner step.
- [ ] **Step 4: Decide whether safeguard S2 is buildable** (spec §8.5).
  - Repeat Steps 1–2 for **The Find** and for a large hotel (e.g. `Cinnamon Grand Colombo`).
  - For each, note whether the Geocoding `formatted_address` **contains the business name**.
  - Record the three answers in spec §8.5:
    - If at least two of three contain the name, S2 is built in Task 4b (step 10b).
    - Otherwise, mark S2 "not built: addresses omit names", and Task 4b skips step 10b.

---

### Task 1: Email ops when a booking is created unpriced

Goal G3, spec §2.4. **Independent of every other task**, and already proposed as its own session ("Alert ops when a booking lands unpriced").

**Files:**
- Modify: `api/src/services/opsNotifications.ts` (add `teamUnpricedEmail`, following `teamRescueEmail`'s shape ~:350-517)
- Modify: `api/src/routes/bookings.ts` (`flagForOps` ~:420: send after the task insert, only when the note starts with `UNPRICED_NOTE_PREFIX` or equals `UNPRICED_NOTE`)
- Test: `api/src/services/opsNotifications.test.ts`, `api/src/routes/bookings.test.ts` (or the existing trip-booking test file; find it with `grep -ln "needs_pricing\|needsPricing" api/src/routes/*.test.ts`)

**Interfaces:**
- Produces: `teamUnpricedEmail(facts: BookingFacts, reason: string, opsUrl: string): { subject: string; html: string; text: string }`

- [ ] **Step 1: Write the failing route test.**
  - Create a trip booking whose stop the fake can't measure (`stops: ['Kandy', 'ZZQQ Nowhere 4417']`).
  - Assert one team email is sent through the fake email adapter.
  - Assert the subject contains `Unpriced` and the booking reference, and the body contains `distance unresolved: Kandy → ZZQQ Nowhere 4417` and the ops booking URL.
  - Assert that a priced booking (`['Kandy', 'Ella']`) sends **no** such email.
- [ ] **Step 2: Run it and see it FAIL:** `cd api && npx vitest run src/routes/bookings.test.ts -t "unpriced"`.
- [ ] **Step 3: Implement.**
  - `flagForOps` stays best-effort: wrap the send in try/catch and log on failure, because an email must never fail the booking.
  - Reuse the existing team-email send helper used by `teamRescueEmail`.
- [ ] **Step 4: Run it and see it PASS;** then run the full gate.
- [ ] **Step 5: Commit.** `git add` the four files by path; `git commit -m "feat(ops): email the team when a booking lands unpriced"`.

---

### Task 2: Floor guard compares unrounded metres

Spec §10 E10. A real short hop is rejected today: 1.4 km of road rounds to 1 against a 1.3 km straight line. This must land before coordinate legs become common (Task 5). The bug is already live for the ops tool's resolved pairs.

**Files:**
- Modify: `api/src/adapters/maps.ts` `googleDistance` (~:362-380)
- Test: `api/src/adapters/maps.test.ts` (new `describe` next to the existing `distanceVariants` block, ~:233)

- [ ] **Step 1: Write the failing test.**

```ts
describe('implausibly-short floor guard', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  function dm(metres: number, seconds: number): Response {
    return new Response(JSON.stringify({ status: 'OK', rows: [{ elements: [{
      status: 'OK', distance: { value: metres }, duration: { value: seconds } }] }] }), { status: 200 });
  }

  // Two points ~1.30 km apart in a straight line. A 1.4 km road is real; rounding it to 1 km
  // before comparing with 0.95 × 1.30 = 1.24 km wrongly rejected it.
  const A = '6.0000,80.0000';
  const B = '6.0117,80.0000';

  it('accepts a short real road that only fails the guard after rounding', async () => {
    global.fetch = (async () => dm(1400, 240)) as typeof fetch;
    const d = await new GoogleMapsAdapter('k').distance(A, B);
    expect(d).toEqual({ km: 1, durationMin: 4 });
  });

  it('still rejects a road genuinely shorter than the straight line', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = (async () => dm(900, 120)) as typeof fetch;
    const d = await new GoogleMapsAdapter('k').distance(A, B);
    expect(d?.estimated).toBe(true); // falls back to the flagged offline estimate, never priced
  });
});
```

- [ ] **Step 2: Run and see the first test FAIL** (today it returns `{ …, estimated: true }`): `cd api && npx vitest run src/adapters/maps.test.ts -t "floor guard"`.
- [ ] **Step 3: Implement.** In `googleDistance`, keep `km` rounded for the result, but compare the raw value:

```ts
    const rawKm = el.distance.value / 1000;
    const km = Math.round(rawKm);
    // …MAX_SL_ROAD_KM check unchanged (uses km)…
    if (o && d) {
      const crowKm = haversineKm(o, d);
      // Compare UNROUNDED metres: a 1.4 km road rounds to 1 and would fail 0.95 × 1.3 km.
      if (rawKm < crowKm * MIN_ROAD_TO_CROW) {
```

- [ ] **Step 4: Run and see both PASS;** then run the full gate.
- [ ] **Step 5: Commit:** `git add api/src/adapters/maps.ts api/src/adapters/maps.test.ts && git commit -m "fix(maps): compare unrounded metres in the short-road floor guard"`.

---

### Task 3: Honest "can't price" state on the booking page

Goal G2, spec §9. Front-end only; it uses the existing 422. It works with today's API: names are shown once Task 4b adds `unresolved`, and before that the copy is generic.

**Files:**
- Modify: `ch-pricing.js` `settle` / `doFetch` (~:57-90)
- Modify: `booking.js` `requestEstimate` (~:1946), the pay gate in `render()` (~:2704), and the pay click handler (~:2786)
- Test: `web-tests/unit/ch-pricing.test.js`; new `web-tests/e2e/booking-unpriced-state.spec.js`

**Interfaces:**
- Produces: `onUnavailable(reason, detail)`, where `reason === 'unpriced'` and `detail = { unresolved: string[] }` for a 422 `quote_unpriced`. Every other reason is unchanged, so `search.js` callers that only log `reason` are unaffected.

- [ ] **Step 1: Write the failing unit test** in `web-tests/unit/ch-pricing.test.js`, following the file's existing fetch-stub pattern:
  - A 422 with body `{"error":"quote_unpriced","unresolved":["Casa Selvita"]}` calls `onUnavailable('unpriced', {unresolved:['Casa Selvita']})`.
  - A 422 with no body calls `onUnavailable('unpriced', {unresolved:[]})`.
  - A 500 still calls `onUnavailable('http_error')`.
  - Nothing is written to the sessionStorage cache for a 422.
- [ ] **Step 2: Run and see it FAIL:** `npm --prefix /Users/roshenw/claude_code/ceylon-hop/web-tests run test:unit -- ch-pricing` (check `web-tests/package.json` for the exact unit script name).
- [ ] **Step 3: Implement in `ch-pricing.js`.**

```js
  function settle(record, fn, arg, detail){
    if(pending !== record) return;
    pending = null;
    record.callbacks.forEach(function(cb){ try { if(cb[fn]) cb[fn](arg, detail); } catch(e){} });
  }
  // in doFetch, before the generic !res.ok branch:
      if(res.status === 422){
        // A deterministic refusal: the server cannot price this itinerary and WILL refuse the
        // booking (bookings.ts awaiting_price). Not an outage — the page must not sell it.
        return res.json().catch(function(){ return null; }).then(function(body){
          if(body && body.error === 'quote_unpriced'){
            const names = Array.isArray(body.unresolved) ? body.unresolved.filter(function(s){ return typeof s === 'string'; }) : [];
            return settle(record, 'onUnavailable', 'unpriced', { unresolved: names });
          }
          return settle(record, 'onUnavailable', 'http_error');
        });
      }
```

- [ ] **Step 4: Run the unit test and see it PASS.**
- [ ] **Step 5: Write the failing e2e** `web-tests/e2e/booking-unpriced-state.spec.js`:
  - Use `_stubs.js`, and route `**/quote/v2/estimate` to answer `422 {"error":"quote_unpriced","unresolved":["Casa Selvita"]}`.
  - Open `booking.html?mode=trip&stops=EKHO%20Sigiriya|Casa%20Selvita&nights=0,0&dates=2027-02-04&pax=2&vehicle=car`.
  - Assert:
    - `#pay-btn` is disabled.
    - `#details-error` contains `We couldn't price Casa Selvita automatically`.
    - A `Change this stop` link points to `plan.html?` and keeps `stops=`.
    - A WhatsApp link is visible.
  - Second test: route the estimate to `abort()` (a network failure) and assert the pay gate **does not** show the unpriced copy (today's fallback is unchanged).
- [ ] **Step 6: Run and see it FAIL.**
- [ ] **Step 7: Implement in `booking.js`.**

```js
// The intent the server has said it CANNOT price (422 quote_unpriced). Keyed by signature so a
// changed itinerary immediately clears it; names come from the API when it sends them.
let engineUnpriced = null; // { sig, names:[] } | null
function currentUnpriced(){ return (engineUnpriced && engineUnpriced.sig===currentIntentSig()) ? engineUnpriced : null; }
function unpricedCopy(u){
  const n=u.names;
  const what = n.length===0 ? 'one of your stops' : n.length===1 ? n[0] : n.slice(0,-1).join(', ')+' and '+n[n.length-1];
  return 'We couldn’t price '+what+' automatically. Pick '+(n.length>1?'them':'it')+' again from the list, or send us the trip and we’ll price it by hand.';
}
```

  - In `requestEstimate`:
    - `onResult`: set `engineUnpriced=null`.
    - `onUnavailable(reason, detail)`: `if(reason==='unpriced'){ engineUnpriced={ sig, names:(detail&&detail.unresolved)||[] }; }`, then continue with the existing body unchanged.
  - In `render()`'s gate, add `currentUnpriced()` **first**: `const unp=currentUnpriced(); const payGateReason = unp ? unpricedCopy(unp) : estimatePending ? …`.
  - Render the two actions under `#details-error` when `unp` is set:
    - trip: `<a href="${buildTripEditUrl(false)}">Change this stop</a>`;
    - single: a button that focuses `#loc-from`/`#loc-to`;
    - plus the existing WhatsApp link builder used by the summary (`waTripSummary`).
  - In the pay click handler, add the same `currentUnpriced()` early return.
- [ ] **Step 8: Run and see it PASS;** run the full gate (`test:all` includes Playwright).
- [ ] **Step 9: Visual check.** Use the browser pane on a local preview with the estimate stubbed (local previews can't reach the prod API). Take a screenshot for the PR.
- [ ] **Step 10:** Run `npm run stamp`, then commit `ch-pricing.js booking.js web-tests/unit/ch-pricing.test.js web-tests/e2e/booking-unpriced-state.spec.js` plus the stamped files: `git commit -m "fix(booking): never offer payment for a trip the server says it can't price"`.

---

### Task 4a: `MapsAdapter.placeById`, resolving a Google place ID server-side

Spec §7. **Interface change, so it is its own step** (CLAUDE.md hard rule 5). Optional method, so existing stubs stay valid. Depends on Task 0.

**Files:**
- Modify: `api/src/adapters/maps.ts`: `ResolvedPlace`, `isPlaceId`, interface method, `GoogleMapsAdapter.placeById` + LRU, `FakeMapsAdapter.placeById`, `FAKE_PLACES`
- Modify: `api/src/adapters/meteredMaps.ts`, `api/src/adapters/cachedMaps.ts`, `api/src/routes/bookings.ts` `memoizeDistance` (~:94-124)
- Test: `api/src/adapters/maps.test.ts`, `meteredMaps.test.ts`, `cachedMaps.test.ts`, and the `memoizeDistance` test (`grep -ln memoizeDistance api/src/**/*.test.ts`)

**Interfaces:**
- Produces:

```ts
export interface ResolvedPlace {
  placeId: string;
  lat: number;
  lng: number;
  name: string;      // Google's first formatted_address component (what ops sees as "Google's name")
  address: string;   // formatted_address
  area: string | null; // administrative_area_level_1
}
export function isPlaceId(s: unknown): s is string; // /^[A-Za-z0-9_-]{10,512}$/
// on MapsAdapter:
placeById?(placeId: string): Promise<ResolvedPlace | null>;
```

- [ ] **Step 1: Write the failing tests** in `maps.test.ts`:

```ts
describe('placeById', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });
  const ID = 'ChIJ_test_casa_selvita_01';

  function geo(status: string, results: unknown[] = []): Response {
    return new Response(JSON.stringify({ status, results }), { status: 200 });
  }

  it('asks Geocoding by place_id and returns the point, address and area', async () => {
    const urls: string[] = [];
    global.fetch = (async (u: string) => { urls.push(String(u)); return geo('OK', [{
      formatted_address: 'Casa Selvita, 12 Temple Rd, Kandy, Sri Lanka',
      geometry: { location: { lat: 7.29, lng: 80.63 } },
      address_components: [{ long_name: 'Central Province', types: ['administrative_area_level_1'] }],
    }]); }) as typeof fetch;
    const p = await new GoogleMapsAdapter('k').placeById(ID);
    expect(urls[0]).toContain(`geocode/json?place_id=${ID}`);
    expect(p).toEqual({ placeId: ID, lat: 7.29, lng: 80.63, name: 'Casa Selvita',
      address: 'Casa Selvita, 12 Temple Rd, Kandy, Sri Lanka', area: 'Central Province' });
  });

  it('never calls Google for a malformed id', async () => {
    let called = false;
    global.fetch = (async () => { called = true; return geo('OK'); }) as typeof fetch;
    expect(await new GoogleMapsAdapter('k').placeById('../../etc')).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null on NOT_FOUND / INVALID_REQUEST and on a network failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = (async () => geo('NOT_FOUND')) as typeof fetch;
    expect(await new GoogleMapsAdapter('k').placeById(ID)).toBeNull();
    global.fetch = (async () => { throw new Error('down'); }) as typeof fetch;
    expect(await new GoogleMapsAdapter('k').placeById(ID)).toBeNull();
  });

  it('caches successes (one call for two lookups) but never a failure', async () => {
    let n = 0;
    global.fetch = (async () => { n++; return geo('OK', [{ formatted_address: 'X, Galle, Sri Lanka',
      geometry: { location: { lat: 6.03, lng: 80.21 } }, address_components: [] }]); }) as typeof fetch;
    const a = new GoogleMapsAdapter('k');
    await a.placeById(ID); await a.placeById(ID);
    expect(n).toBe(1);
    let m = 0;
    global.fetch = (async () => { m++; throw new Error('down'); }) as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new GoogleMapsAdapter('k');
    await b.placeById(ID); await b.placeById(ID);
    expect(m).toBe(2);
  });

  it('fake: resolves fake ids from its table and nothing else', async () => {
    const f = new FakeMapsAdapter();
    expect(await f.placeById('fake_casa_selvita')).toMatchObject({ name: 'Casa Selvita', area: 'Central Province' });
    expect(await f.placeById('ChIJ_unknown_000000')).toBeNull();
  });
});
```

- [ ] **Step 2: Run and see it FAIL:** `cd api && npx vitest run src/adapters/maps.test.ts -t placeById`.
- [ ] **Step 3: Implement in `maps.ts`.**

```ts
export function isPlaceId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{10,512}$/.test(s);
}

// Test/dev place ids. Coordinates near (not on) catalogue towns, so a fake hotel measures like a
// real one and never collides with COORDS (which would route it through step 1 instead).
const FAKE_PLACES: Record<string, Omit<ResolvedPlace, 'placeId'>> = {
  fake_casa_selvita: { lat: 7.3, lng: 80.64, name: 'Casa Selvita', address: 'Casa Selvita, Kandy, Sri Lanka', area: 'Central Province' },
  fake_the_find: { lat: 5.97, lng: 80.43, name: 'The Find', address: 'The Find, Ahangama, Sri Lanka', area: 'Southern Province' },
  fake_ekho_sigiriya: { lat: 7.95, lng: 80.75, name: 'EKHO Sigiriya', address: 'EKHO Sigiriya, Sigiriya, Sri Lanka', area: 'Central Province' },
};
```

  - `FakeMapsAdapter.placeById(id)`: `isPlaceId(id) && FAKE_PLACES[id] ? { placeId: id, ...FAKE_PLACES[id] } : null`.
  - `GoogleMapsAdapter`:
    - Add a `placeCache = new Map<string, { expires: number; value: ResolvedPlace }>()`, same as `variantsCache`: 24 h, clear at 500, successes only.
    - Add `placeById(id)`: return `null` unless `isPlaceId(id)`; check the cache; fetch `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(id)}&key=${this.apiKey}` with the same `AbortController`/`FETCH_TIMEOUT_MS` pattern as `geocodeAll`.
    - Treat any status other than `OK` as `null` (log `[maps] placeById error: <status>`).
    - Map `results[0]`: `name = formatted_address.split(',')[0].trim()`, and `area` from `administrative_area_level_1`.
- [ ] **Step 4: Forward the method in the three wrappers.** Same conditional-assignment pattern they use for `geocode`:
  - `MeteredMapsAdapter`: `if (inner.placeById) this.placeById = (id) => this.count('maps.place_by_id', () => inner.placeById!(id));`
  - `CachedMapsAdapter`: `if (inner.placeById) this.placeById = (id) => inner.placeById!(id);`
  - `memoizeDistance` (`bookings.ts`): add `...(maps.placeById ? { placeById: (id: string) => memo(placeIds, id, () => maps.placeById!(id)) } : {})`, where `placeIds` is a per-request `Map<string, Promise<ResolvedPlace | null>>`. Also forward `geocode` the same way. It is dropped today (agent inventory §2), and forwarding it is harmless.
  - Add one test per wrapper: present when the inner adapter has it, absent when it doesn't, and the metered key `maps.place_by_id` bumps.
- [ ] **Step 5: Run and see it PASS;** then run the full gate.
- [ ] **Step 6: Commit** the seven files by path: `git commit -m "feat(maps): resolve a Google place id server-side (placeById, optional)"`.

---

### Task 4b: Identify stops and price picked places by their place ID (API)

Spec §6, §8.1, §8.2, §13. **Public schema change: promote it to production on its own, before Tasks 5, 6 or 9 merge.**

**Files:**
- Create: `api/src/quote/stopIdentity.ts`, `api/src/quote/stopIdentity.test.ts`
- Modify: `api/src/quote/webQuoteV2.ts` (+`webQuoteV2.test.ts`), `api/src/domain/trip.ts`, `api/src/domain/singleTransfer.ts`
- Modify: `api/src/services/pricing.ts` (+test), `api/src/routes/quote.ts` (+test), `api/src/routes/bookings.ts` (+test), `api/src/app.ts`

**Interfaces:**
- Consumes: `MapsAdapter.placeById?`, `isPlaceId`, `ResolvedPlace` (Task 4a); `PlaceResolutionRepo.get` (existing); `knownCoords`, `canonPlace` (existing).
- Produces:

```ts
export type StopSource = 'catalogue' | 'place_id' | 'confirmed' | 'text';
export interface IdentifiedStop {
  name: string;          // the display name, unchanged — what the engine and storage keep
  measure: string;       // what measureLeg is called with: the name, or "lat,lng"
  source: StopSource;
  place?: ResolvedPlace; // only for source 'place_id'
  lat?: number; lng?: number; // catalogue / confirmed / place_id
}
export async function identifyStops(
  names: string[],
  placeIds: (string | undefined)[] | undefined,
  deps: { maps: MapsAdapter; placeResolutions?: PlaceResolutionRepo; meter?: { bump(key: string): void } },
): Promise<IdentifiedStop[]>;
// pricing.ts
export async function priceSingle(input, maps, rateCard?, discount?, measure?: { from: string; to: string }): Promise<PriceOutcome>;
export async function priceTrip(input, maps, rateCard?, discount?, measure?: string[]): Promise<PriceOutcome>;
// PriceOutcome unpriced arm gains: unresolved?: string[]   (display names)
// stopIdentity.ts, only if Task 0 step 4 says build S2:
export function placeLabelMismatch(label: string, place: ResolvedPlace): boolean;
```

- [ ] **Step 1: Write the failing `stopIdentity.test.ts`:**

```ts
import { describe, expect, it, vi } from 'vitest';
import { FakeMapsAdapter } from '../adapters/maps';
import { InMemoryPlaceResolutionRepo } from '../db/placeResolutionRepo';
import { identifyStops } from './stopIdentity';

describe('identifyStops (spec §6)', () => {
  const maps = new FakeMapsAdapter();

  it('1 — a catalogue town measures by its NAME, even with a place id (prices + cache unchanged)', async () => {
    const [s] = await identifyStops(['Kandy'], ['fake_casa_selvita'], { maps });
    expect(s).toMatchObject({ name: 'Kandy', measure: 'Kandy', source: 'catalogue' });
  });

  it('2 — a place id measures by the server-resolved point; the name is kept', async () => {
    const [s] = await identifyStops(['Casa Selvita'], ['fake_casa_selvita'], { maps });
    expect(s).toMatchObject({ name: 'Casa Selvita', measure: '7.3,80.64', source: 'place_id' });
    expect(s.place?.area).toBe('Central Province');
  });

  it('3 — a confirmed place_resolutions row is used READ-ONLY (never resolve(), never upsert)', async () => {
    const repo = new InMemoryPlaceResolutionRepo();
    await repo.upsert({ canonKey: 'the find', displayName: 'The Find', lat: 5.97, lng: 80.43, source: 'confirmed' });
    const upsert = vi.spyOn(repo, 'upsert');
    const [s] = await identifyStops(['The Find'], undefined, { maps, placeResolutions: repo });
    expect(s).toMatchObject({ measure: '5.97,80.43', source: 'confirmed' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('4 — anything else is today\'s text path, unchanged', async () => {
    const [s] = await identifyStops(['Casa Selvita'], undefined, { maps });
    expect(s).toEqual({ name: 'Casa Selvita', measure: 'Casa Selvita', source: 'text' });
  });

  it('an unresolvable / malformed id falls through, never worse than today', async () => {
    const [a, b] = await identifyStops(['Casa Selvita', 'The Find'], ['ChIJ_unknown_000000', '../x'], { maps });
    expect(a.source).toBe('text');
    expect(b.source).toBe('text');
  });

  it('a place id the adapter cannot resolve (no placeById) falls through', async () => {
    const bare = { ...maps, placeById: undefined, distance: maps.distance.bind(maps) } as never;
    const [s] = await identifyStops(['Casa Selvita'], ['fake_casa_selvita'], { maps: bare });
    expect(s.source).toBe('text');
  });

  it('bumps one usage counter per stop by source', async () => {
    const bump = vi.fn();
    await identifyStops(['Kandy', 'Casa Selvita'], ['', 'fake_casa_selvita'], { maps, meter: { bump } });
    expect(bump.mock.calls.map((c) => c[0])).toEqual(['pricing.stop.catalogue', 'pricing.stop.place_id']);
  });

  it('ignores a placeIds array whose length does not match names', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await identifyStops(['Casa Selvita', 'Kandy'], ['fake_casa_selvita'], { maps });
    expect(out[0].source).toBe('text');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[place] placeIds length mismatch'));
  });
});
```

- [ ] **Step 2: Run and see it FAIL** (module missing): `cd api && npx vitest run src/quote/stopIdentity.test.ts`.
- [ ] **Step 3: Implement `stopIdentity.ts`.**

```ts
import { canonPlace, isPlaceId, knownCoords, type MapsAdapter, type ResolvedPlace } from '../adapters/maps';
import type { PlaceResolutionRepo } from '../db/placeResolutionRepo';

// Spec 2026-10-18 §6 — which string a stop is MEASURED with, in order of trust. The display name
// is never replaced: the engine (hot zones match names), storage, emails and analytics keep it.
// Every fallback is today's behaviour, so nothing that prices now stops pricing.
export type StopSource = 'catalogue' | 'place_id' | 'confirmed' | 'text';
export interface IdentifiedStop {
  name: string;
  measure: string;
  source: StopSource;
  place?: ResolvedPlace;
  lat?: number;
  lng?: number;
}

export async function identifyStops(
  names: string[],
  placeIds: (string | undefined)[] | undefined,
  deps: { maps: MapsAdapter; placeResolutions?: PlaceResolutionRepo; meter?: { bump(key: string): void } },
): Promise<IdentifiedStop[]> {
  let ids = placeIds;
  if (ids && ids.length !== names.length) {
    console.warn(`[place] placeIds length mismatch: ${ids.length} ids for ${names.length} stops — ignored`);
    ids = undefined;
  }
  const out: IdentifiedStop[] = [];
  for (let i = 0; i < names.length; i++) {
    const stop = await identifyOne(names[i], ids?.[i], deps);
    deps.meter?.bump(`pricing.stop.${stop.source}`);
    out.push(stop);
  }
  return out;
}

async function identifyOne(
  name: string,
  placeId: string | undefined,
  deps: { maps: MapsAdapter; placeResolutions?: PlaceResolutionRepo },
): Promise<IdentifiedStop> {
  // 1. Catalogue: measure by name, exactly as today (distance_cache, advertised fares).
  const known = knownCoords(name);
  if (known) return { name, measure: name, source: 'catalogue', lat: known[0], lng: known[1] };
  // 2. A Google place id the customer picked — resolved HERE, never trusted from the browser.
  if (isPlaceId(placeId) && deps.maps.placeById) {
    const place = await deps.maps.placeById(placeId).catch(() => null);
    if (place) return { name, measure: `${place.lat},${place.lng}`, source: 'place_id', place, lat: place.lat, lng: place.lng };
  }
  // 3. A human-confirmed (or catalog/auto-linked) identity — READ-ONLY. resolve() would geocode
  //    and write auto_linked rows from public traffic.
  if (deps.placeResolutions) {
    const row = await deps.placeResolutions.get(canonPlace(name)).catch(() => null);
    if (row) return { name, measure: `${row.lat},${row.lng}`, source: 'confirmed', lat: row.lat, lng: row.lng };
  }
  // 4. Today's text path, unchanged.
  return { name, measure: name, source: 'text' };
}
```

- [ ] **Step 4: Run and see it PASS.**
- [ ] **Step 5: Write the failing schema tests.**
  - `webQuoteV2.test.ts`:
    - `fromPlaceId`/`toPlaceId` are accepted on a private leg and on a chauffeur day.
    - An unknown key is **still** rejected (the existing `distanceKm` test stays green).
    - A non-string `fromPlaceId` is rejected.
  - `trip` test: `stopPlaceIds` is accepted.
  - `singleTransfer` test (or a route test): `fromPlaceId` is accepted.
- [ ] **Step 6: Implement the schemas.**
  - `webQuoteV2.ts`: inside both strict leg/day objects, `fromPlaceId: z.string().max(512).optional(), toPlaceId: z.string().max(512).optional(),`.
  - `trip.ts`: `stopPlaceIds: z.array(z.string().max(512)).max(MAX_TRIP_STOPS).optional(),`, with a comment: length checked in `identifyStops`, `''` = none.
  - `singleTransfer.ts`: `fromPlaceId`/`toPlaceId` as optional strings, max 512.
  - **Format validation stays in `isPlaceId`, so a bad ID is ignored, not a 400** (spec §7).
- [ ] **Step 7: Write the failing pricing tests** in `pricing.test.ts`:

```ts
it('incident regression: a picked hotel prices by its place id; the engine still sees names', async () => {
  const maps = new FakeMapsAdapter();
  const input = { stops: ['Kandy', 'Casa Selvita'], nights: [0, 0], pax: 2, vehicleType: 'car', serviceType: 'private' } as never;
  expect((await priceTrip(input, maps)).priced).toBe(false); // today: the bare name is unpriceable
  const out = await priceTrip(input, maps, undefined, undefined, ['Kandy', '7.3,80.64']);
  expect(out.priced).toBe(true);
  if (out.priced) expect(out.breakdown!.engine).toMatchObject({ legs: [{ from: 'Kandy', to: 'Casa Selvita' }] });
});

it('unpriced outcome names the unresolved stops', async () => {
  const out = await priceTrip({ stops: ['Kandy', 'Casa Selvita'], nights: [0, 0], pax: 2, vehicleType: 'car', serviceType: 'private' } as never, new FakeMapsAdapter());
  expect(out).toMatchObject({ priced: false, unresolved: ['Casa Selvita'] });
});
```

  Also add a hot-zone test in `hotZonesEngine.test.ts`: a trip priced with a `"lat,lng"` measure for a stop **named** after a zone town still gets the boost (names reach the engine).
- [ ] **Step 8: Implement in `pricing.ts`.**
  - `priceTrip` gets an optional `measure?: string[]`, index-aligned with `input.stops`; when it is absent or the wrong length, `measure = input.stops`.
  - Inside the loop: `measureLeg(maps, measure[i], measure[i + 1], …)`, while `legs.push({ from, to, … })` keeps the names.
  - The unpriced message keeps the names (`distance unresolved: ${from} → ${to}`). The ops note and Task 1's email therefore read exactly as today.
  - `unpriced()` gains an optional `unresolved` argument: return `unresolved: [from, to].filter((s) => !knownCoords(s))`, the endpoints of the failing leg that weren't catalogue towns.
  - `priceSingle` gets the same treatment with `measure?: { from: string; to: string }`.
- [ ] **Step 9: Wire `engineRequestFor` (`quote.ts` ~:69-130).**
  - Add a third parameter: `ident?: { placeResolutions?: PlaceResolutionRepo; meter?: { bump(k: string): void } }`.
  - Private product, for each leg:
    - `const [a, b] = await identifyStops([leg.from, leg.to], [leg.fromPlaceId, leg.toPlaceId], { maps, ...ident });`
    - Then `measureLeg(maps, a.measure, b.measure, leg.routeVariant)`.
    - The memoized adapter means a stop shared by two legs is resolved once.
  - Chauffeur: the same per `travelDays` entry, with `maps.distance(a.measure, b.measure)`.
  - `ResolvedLeg` and `request.legs` keep `from: leg.from`, `to: leg.to`.
  - Return type: when a leg can't be measured, return `{ unpriced: true, unresolved: string[] }` instead of `null`, and update the two call sites (`/v2/estimate` and the v2 quote save path; grep `engineRequestFor(`).
  - `/v2/estimate` answers `422 { error: 'quote_unpriced', unresolved }`.
  - Test in `quote.test.ts`:
    - A leg `{from:'Kandy', to:'Casa Selvita', toPlaceId:'fake_casa_selvita'}` prices.
    - The same without the ID gives 422 with `unresolved: ['Casa Selvita']`.
    - **The response `legs[].to` is `'Casa Selvita'`, not coordinates**, because `booking.js` `lockLegKm` matches legs by name (`booking.js:1932`).
- [ ] **Step 10: Wire the booking routes (`bookings.ts`).**
  - `/bookings/single` (~:586-640): `const ids = await identifyStops([d.from, d.to], [d.fromPlaceId, d.toPlaceId], {...})`; pass `{ from: ids[0].measure, to: ids[1].measure }` to `priceSingle`, and use the same measures in the stored-distance `measureLeg` call.
  - `/bookings/trip` (~:700-760): `identifyStops(d.stops, d.stopPlaceIds, {...})`; pass `ids.map((s) => s.measure)` to `priceTrip`, and use the same measures in the `tripKm` loop.
  - Keep `ids` in a local variable; Task 7 stores them.
  - Add `placeResolutions?: PlaceResolutionRepo` and `usageMeter?: { bump(k: string): void }` to `bookingRoutes` and `quoteRoutes` deps. In `app.ts`, pass the existing `placeResolutions` (~:278) and `deps.usageMeter` (~:187).
  - Test in the trip-booking route test:
    - With `stopPlaceIds: ['', 'fake_casa_selvita']`, the booking is **not** `needsPricing`.
    - Without it, it is (unchanged).
    - The stored `input.stops` is `['Kandy','Casa Selvita']`.
    - With `stopPlaceIds` of the wrong length, it prices exactly as without (and logs).
- [ ] **Step 10b: Safeguard S2: flag a label that doesn't match its place** (spec §8.5). **Only if Task 0 Step 4 recorded "build S2".** Otherwise skip, and say so in the PR.
  - **Failing unit test** in `api/src/quote/stopIdentity.test.ts`:

```ts
import { placeLabelMismatch } from './stopIdentity';

describe('placeLabelMismatch (spec §8.5)', () => {
  const place = (address: string) => ({ placeId: 'fake_x_000000', lat: 7.3, lng: 80.64, name: address.split(',')[0], address, area: 'Central Province' });
  it('no flag when a distinctive word of the label is in the address', () => {
    expect(placeLabelMismatch('Casa Selvita', place('Casa Selvita, 12 Temple Rd, Kandy, Sri Lanka'))).toBe(false);
    expect(placeLabelMismatch('The Find', place('The Find, Ahangama, Sri Lanka'))).toBe(false);
  });
  it('generic words alone never count as a match', () => {
    expect(placeLabelMismatch('Hilton Colombo Hotel', place('Galle Road Hotel, Galle, Sri Lanka'))).toBe(true);
  });
  it('flags a label that names a different place', () => {
    expect(placeLabelMismatch('Shangri-La Colombo', place('Hikkaduwa Beach Resort, Hikkaduwa, Sri Lanka'))).toBe(true);
  });
  it('a label with no distinctive words is never flagged (nothing to compare)', () => {
    expect(placeLabelMismatch('The Villa', place('Anything, Galle, Sri Lanka'))).toBe(false);
  });
});
```

  - **Implement** in `stopIdentity.ts`:

```ts
const GENERIC = new Set(['hotel', 'villa', 'resort', 'the', 'and', 'guest', 'house', 'sri', 'lanka', 'road']);
const words = (s: string) => (s.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !GENERIC.has(w));
// True when the label's distinctive words are all missing from Google's address for the id —
// the customer's label and the place we will price and drive to plainly disagree (spec §8.5, E7).
export function placeLabelMismatch(label: string, place: ResolvedPlace): boolean {
  const mine = words(label);
  if (!mine.length) return false;
  const theirs = new Set(words(`${place.name} ${place.address}`));
  return !mine.some((w) => theirs.has(w));
}
```

  `rd` and `by` are under 3 letters, so the 3+ rule already drops them.
  - **Failing route test** in the trip-booking route test:
    - `stopPlaceIds: ['', 'fake_casa_selvita']` with stop label `'Shangri-La Colombo'` creates the booking priced, **plus** one concierge task whose note starts `check place: "Shangri-La Colombo" was priced on Google place "Casa Selvita, Kandy, Sri Lanka"`.
    - The label `'Casa Selvita'` creates no such task.
    - The booking's price and `needsPricing` are identical in both cases.
  - **Implement** in `bookings.ts`, after `bookings.create` in both the single and trip handlers:

```ts
for (const s of ids) {
  if (s.source === 'place_id' && s.place && placeLabelMismatch(s.name, s.place)) {
    await flagForOps(booking, `check place: "${s.name}" was priced on Google place "${s.place.address}" (${s.place.area ?? 'area unknown'})`);
  }
}
```

    `flagForOps` is already best-effort (try/catch). Task 1's email fires only for unpriced notes, so these go to the ops queue, not the inbox.

- [ ] **Step 11: Compatibility guard test** (in `quote.test.ts`): an intent with **no** place IDs produces the same `fingerprintIntent` and the same 200 body as before. Snapshot one known intent's fingerprint string, computed from `main` before the change and pasted into the test.
- [ ] **Step 12: Run the full gate;** paste red→green into the PR.
- [ ] **Step 13: Commit** by path: `git commit -m "feat(pricing): price a picked place by its Google place id; names unchanged"`.
- [ ] **Step 14: Release.** After merge and the staging check, ask the owner to **promote this alone** (a pinned promote PR, following the SHA-pinned promote memory). Verify prod `/health` reports the new sha, then curl prod:

```bash
curl -s -X POST https://ceylon-hop-api.onrender.com/quote/v2/estimate -H 'content-type: application/json' \
  -d '{"product":"private","vehicle":"car","pax":2,"bags":0,"extras":[],"legs":[{"from":"Kandy","to":"Casa Selvita","toPlaceId":"<ID from Task 0>"}]}' | jq '{totalCents,legs,error,unresolved}'
```

Expected: a `totalCents` value, and `legs[0].to == "Casa Selvita"`. Without `toPlaceId`, expected: `quote_unpriced` with `unresolved: ["Casa Selvita"]`.

---

### Task 5: Planner and trip booking send place IDs; area line

Spec §8.3, §8.4. **Gate: Task 4b is live on production** (re-check `/health` sha right before merging).

**Files:**
- Modify: `ch-map.js` `resolvePick` (~:660-676)
- Modify: `plan.js`: Google pick (~:326-328), `routeSeqDetailed` (~:494-533), `syncPlanUrl` (~:534-552), `goToBooking` (~:1633-1656), URL load (find where `stops` is read on load: `grep -n "get('stops')" plan.js`), leg rendering for the area line
- Modify: `booking.js`: trip parse (~:184-191), `tripEditQuery` (~:748), `itineraryIntent` trip branches (~:1790-1814), trip payload (~:3337-3356), trip summary area line
- Modify: `web-tests/e2e/_stubs.js` (~:55-82) and `web-tests/e2e/plan-dates.spec.js` stub (~:59-67): predictions gain `placeId`, and `toPlace()` gains `id`
- Test: new `web-tests/e2e/plan-place-identity.spec.js`; additions to `web-tests/unit/booking-intent.test.js`

**Interfaces:**
- Consumes: the API fields from Task 4b (`legs[].fromPlaceId/toPlaceId`, `travelDays[].fromPlaceId/toPlaceId`, `stopPlaceIds`).
- Produces: URL param `pids` (comma-joined, index-aligned with `stops`, empty slot = none). `CH_MAP.resolvePick()` returns `{ name, address, lat, lng, placeId, area }`.

- [ ] **Step 1: Write the failing compatibility unit tests** in `booking-intent.test.js`:
  - With no `pids`, the trip intent, trip payload and `idempotencyKeyFor` output are **identical** to the existing expectations. Assert that the existing `toEqual` cases still pass, and add `expect(JSON.stringify(payload)).not.toContain('PlaceId')`.
  - With `pids=,fake_casa_selvita`:
    - The trip private intent is `legs:[{from:'Kandy',to:'Casa Selvita',toPlaceId:'fake_casa_selvita'}]` (no `fromPlaceId` key at all).
    - The payload has `stopPlaceIds:['','fake_casa_selvita']`.
  - `pids` with the wrong count is ignored entirely.
- [ ] **Step 2: Write the failing e2e** `plan-place-identity.spec.js`:
  - Stub returns `placeId: 'fake_casa_selvita'` for the prediction `Casa Selvita Result 1`.
  - In the planner, set leg 1 to `Kandy` → Google-pick `Casa Selvita`.
  - Assert the input still shows `Casa Selvita` (unchanged), and an area line `Central Province`/`Kandy` from `secondaryText` is shown.
  - Continue to booking: the URL has `pids=` with the ID in the second slot.
  - The intercepted `/quote/v2/estimate` body has `toPlaceId`.
  - The intercepted `/bookings/trip` body has `stopPlaceIds`.
  - **Edit-trip round trip:** follow "Edit trip" back to the planner and forward again; `pids` survives.
  - Typing over the picked stop (`Casa Selvita X`) drops its ID (`pids` slot empty).
- [ ] **Step 3: Run both and see them FAIL.**
- [ ] **Step 4: `ch-map.js` `resolvePick`.** Add the ID and area to the return (`place.id` is available after `toPlace()` without an extra field, per spec §7; `item.secondary` is already on the suggestion):

```js
      return {
        name: item.main || place.displayName || (place.formattedAddress || '').split(',')[0],
        address: place.formattedAddress || '',
        lat: loc ? loc.lat() : null,
        lng: loc ? loc.lng() : null,
        placeId: place.id || (item._p && item._p.placeId) || null,
        area: item.secondary || '',
      };
```

- [ ] **Step 5: `plan.js` `pickedPlaces`, keyed by the committed string** (spec §8.3).

```js
// Google picks by the exact name they committed (norm'd). Keyed by STRING, not threaded per leg:
// chaining, swap, reorder, templates and the edit round-trip all copy the string, so they carry
// the identity for free; typing anything else simply doesn't match.
const pickedPlaces=new Map(); // norm(name) -> { placeId, area }
function pickedFor(name){ return pickedPlaces.get(norm(name||'')) || null; }
```

  - In the Google pick handler (~:326): after `input.value=geo.name`, run `if(geo && geo.placeId) pickedPlaces.set(norm(geo.name), { placeId: geo.placeId, area: geo.area||'' });`.
  - `routeSeqDetailed`: return `pids: seq.map(s => (pickedFor(s.place)||{}).placeId || '')`.
  - `goToBooking` and `syncPlanUrl`: `if(pids.some(Boolean)) p.set('pids', pids.join(',')); else p.delete('pids');`.
  - On load, where `stops` is parsed: read `pids`; when its count equals the `stops` count, `pickedPlaces.set(norm(stop), { placeId: id, area:'' })` for each non-empty ID.
  - Area line: in the leg render, under a stop input whose `pickedFor(value)` has an `area`, render `<small class="leg-area">${escAttr(area)}</small>`. Add a matching small muted style in `site.css` (scoped `.leg-area`, per the generated-CSS collision memory).
- [ ] **Step 6: `booking.js` trip mode.**
  - Parse (~:191): `tripPlaceIds = (()=>{ const a=(params.get('pids')||'').split(','); return a.length===tripStops.length && a.some(Boolean) ? a.map(s=>s.trim()) : null; })();`. Declare `let tripPlaceIds=null;` next to `tripStops` (~:91).
  - `tripEditQuery` (~:748): append `pids` when `tripPlaceIds`.
  - `itineraryIntent` private trip legs (~:1812): `Object.assign({ from: tripStops[i], to: tripStops[i+1] }, pidAt(i) ? { fromPlaceId: pidAt(i) } : {}, pidAt(i+1) ? { toPlaceId: pidAt(i+1) } : {}, …)`, where `function pidAt(i){ return tripPlaceIds ? (tripPlaceIds[i]||'') : ''; }`.
  - Apply the same to `travelDays` (~:1804).
  - Trip payload (~:3337): `stopPlaceIds: tripPlaceIds || undefined`. Being `undefined`, it is dropped by `JSON.stringify`, so the payload stays byte-identical without IDs.
- [ ] **Step 7: Update the stubs** (`_stubs.js`, `plan-dates.spec.js`): add `placeId` to predictions and `id` to `toPlace()`. **Don't change** the existing `mainText` value: `plan-dates.spec.js:296-318` asserts the short name, which must stay.
- [ ] **Step 7b: Safeguard: retry the estimate without place IDs on a 400** (spec §11, safeguard S1). Even if the release order is ever broken, an old strict API can't take pricing down.
  - **Failing unit test** in `web-tests/unit/ch-pricing.test.js`:
    1. An intent with `legs[1].toPlaceId` gets `400 {"error":"invalid_request"}`, then is re-sent **once** with every `fromPlaceId`/`toPlaceId` key removed. The second (200) answer reaches `onResult`.
    2. That retried answer is **not** written to the sessionStorage cache, so the next visit asks again once the API is current.
    3. An intent with **no** place IDs that gets a 400 is **not** retried (`onUnavailable('http_error')`, exactly today's behaviour).
    4. A 400 on the retry itself calls `onUnavailable('http_error')`. No loop.
  - **Implement** in `ch-pricing.js` `doFetch`, before the generic `!res.ok` branch:

```js
      if(res.status === 400 && !record.retriedWithoutIds && hasPlaceIds(record.intent)){
        // An API older than the page rejects the new optional fields (WebQuoteIntentSchema is
        // .strict()). Ask again by name only — today's behaviour — rather than lose the price.
        record.retriedWithoutIds = true;
        record.intent = withoutPlaceIds(record.intent);
        record.noCache = true;
        if(typeof window.chTrack === 'function') window.chTrack('estimate_retry_without_place_ids', {});
        return doFetch(record);
      }
```

    with these helpers:

```js
  function hasPlaceIds(intent){
    const rows = (intent && (intent.legs || intent.travelDays)) || [];
    return rows.some(function(r){ return r && (r.fromPlaceId || r.toPlaceId); });
  }
  function withoutPlaceIds(intent){
    const strip = function(r){ const o = Object.assign({}, r); delete o.fromPlaceId; delete o.toPlaceId; return o; };
    const out = Object.assign({}, intent);
    if(out.legs) out.legs = out.legs.map(strip);
    if(out.travelDays) out.travelDays = out.travelDays.map(strip);
    return out;
  }
```

    In the success branch, `if(!record.noCache) writeCache(record.sig, est);`. `record.sig` stays the original signature, so the page adopts the answer for the itinerary it asked about.
  - **Why only the estimate:** the booking bodies (`TripInput`, `SingleTransferInput`) use Zod's default strip, so an old API silently ignores the new fields there. Verified in the server inventory: `singleTransfer.ts:83`, `trip.ts:14` are not `.strict()`. A booking can't fail this way; only the estimate can.
- [ ] **Step 8: Run the new tests and see them PASS;** then the full gate (`test:all`). Expect the existing payload/`toEqual` suites to pass **without edits**. If one needs an edit, the omit-when-absent rule is broken: fix the code, not the test.
- [ ] **Step 9: Visual check** of the area line in the browser pane (planner and booking summary) at desktop and mobile widths. Take a screenshot for the PR.
- [ ] **Step 10:** Run `npm run stamp`, then commit by path: `git commit -m "feat(plan): carry the picked Google place to booking so hotels price"`.
- [ ] **Step 11: Live check after promotion.** On ceylonhop.com, plan `EKHO Sigiriya → Casa Selvita` with a Google pick; the booking page shows a price and an enabled pay button. **Stop before paying.**

---

### Task 6: Booking exact-spot fields send place IDs (single transfer)

Spec §8.3. **Gate: Task 4b is live on production.**

**Files:**
- Modify: `booking.js`: `choose()` (~:493-511), `itineraryIntent` single branch (~:1818), single payload (~:3384-3398), `lockLegKm` unchanged
- Test: `web-tests/unit/booking-intent.test.js`; extend `web-tests/e2e/booking-engine-price.spec.js` or add `booking-spot-identity.spec.js`

- [ ] **Step 1: Write the failing tests.**
  - Unit: with `state.locToGeo = { name:'Casa Selvita', placeId:'fake_casa_selvita' }` and `state.locTo === 'Casa Selvita'`, the single intent leg has `toPlaceId`.
  - Unit: when `state.locTo` differs from `locToGeo.name` (edited after the pick), there is **no** `toPlaceId`.
  - Unit: with no geo, the intent and payload are byte-identical to today.
  - e2e: Google-pick a drop-off spot; the `/quote/v2/estimate` and `/bookings/single` bodies carry `toPlaceId`; typing after the pick removes it.
- [ ] **Step 2: Run and see them FAIL.**
- [ ] **Step 3: Implement.**

```js
// The picked place id for a spot field — only while the field still says exactly what was picked.
function spotPlaceId(which){
  const geo = which==='from' ? state.locFromGeo : state.locToGeo;
  const text = which==='from' ? state.locFrom : state.locTo;
  return (geo && geo.placeId && geo.name===text) ? geo.placeId : '';
}
```

  - Single intent leg (~:1818): `Object.assign({ from:…, to:… }, spotPlaceId('from') ? { fromPlaceId: spotPlaceId('from') } : {}, spotPlaceId('to') ? { toPlaceId: spotPlaceId('to') } : {}, bookRoad==='no_tolls' ? { routeVariant:'no_tolls' } : {})`.
  - Single payload (~:3384): `fromPlaceId: spotPlaceId('from') || undefined, toPlaceId: spotPlaceId('to') || undefined`.
- [ ] **Step 4: Run and see them PASS;** then run the full gate.
- [ ] **Step 5:** Run `npm run stamp`, then commit by path: `git commit -m "feat(booking): send the picked spot's place id with a single transfer"`.

---

### Task 7: Keep the resolved place on the booking (migration)

Spec §12. **Migration: it ships to staging at merge and to prod on the owner's promotion. Flag it in the proposal.** Owner decision O1 (whether Google coordinates may be written) must be recorded in the spec before starting. The default is IDs only.

**Files:**
- Create: `api/drizzle/0074_booking_leg_place_ids.sql`. Renumber if `main` already has 0074; check with `git ls-tree --name-only origin/main api/drizzle/`.
- Modify: `api/drizzle/meta/_journal.json` (`when` = previous + 86400000), `api/src/db/schema.ts` (`bookingLegs` ~:314)
- Modify: `api/src/domain/bookingLegs.ts` (add `applyLegIdentities`), `api/src/db/bookingRepo.ts` (`NewBooking` gains `legIdentities?`), `api/src/db/postgresBookingRepo.ts` (`legRowsForBooking` ~:177), `api/src/routes/bookings.ts` (pass the `ids` kept in Task 4b)
- Test: `api/src/domain/bookingLegs.test.ts`, `api/src/db/postgresBookingRepo.legs.test.ts`, a new `api/src/db/bookingLegPlaceIdsMigration.test.ts` (copy the shape of `bookingLegsMigration.test.ts`)

**Interfaces:**
- Consumes: `IdentifiedStop` (Task 4b).
- Produces:

```ts
export interface LegIdentity { placeId?: string; lat?: number; lng?: number }
export function applyLegIdentities(
  legs: DerivedLeg[],
  identities: Record<string, LegIdentity> | undefined, // keyed by the exact stop string
): (DerivedLeg & { fromPlaceId?: string; toPlaceId?: string; fromLat?: number; fromLng?: number; toLat?: number; toLng?: number })[];
// bookings.ts helper
export function legIdentitiesFrom(stops: IdentifiedStop[], writeGoogleCoords: boolean): Record<string, LegIdentity>;
```

- [ ] **Step 1: Write the failing migration test.**
  - After migrating, `booking_legs` has nullable `from_place_id`/`to_place_id` text columns.
  - The journal `when` is strictly increasing (the existing assertion pattern).
  - An existing row inserted before the migration reads back unchanged, with nulls.
- [ ] **Step 2: Write the migration.**

```sql
-- Spec 2026-10-18 §12: the Google place id a customer picked, kept as provenance (Google allows
-- storing place ids indefinitely). Nullable, no default: existing rows are untouched.
ALTER TABLE "booking_legs" ADD COLUMN "from_place_id" text;
--> statement-breakpoint
ALTER TABLE "booking_legs" ADD COLUMN "to_place_id" text;
```

  Then `schema.ts`: `fromPlaceId: text('from_place_id'), toPlaceId: text('to_place_id'),` next to the coordinate columns.
- [ ] **Step 3: Write the failing domain test** for `applyLegIdentities` and `legIdentitiesFrom`, following the spec §12 table:
  - catalogue → coordinates, no ID;
  - `place_id` → ID, and coordinates **only** when `writeGoogleCoords` is true;
  - `confirmed` → coordinates;
  - `text` → nothing;
  - `undefined` identities → legs unchanged (byte-identical to today's rows).
- [ ] **Step 4: Implement.**
  - `applyLegIdentities` maps each leg's `fromPlace`/`toPlace` through the record.
  - `legIdentitiesFrom` builds the record from the `IdentifiedStop[]`.
  - `writeGoogleCoords` is a named constant in `bookings.ts`, `WRITE_GOOGLE_COORDS = false`, with a comment pointing at spec §12 O1. It is a constant, not config: it only changes by owner decision through a PR.
  - `NewBooking` gains `legIdentities?: Record<string, LegIdentity>`.
  - `legRowsForBooking` calls `applyLegIdentities(legs, b.legIdentities)` before mapping in `bookingId`.
  - The website `/bookings/single` and `/bookings/trip` handlers pass `legIdentities: legIdentitiesFrom(ids, WRITE_GOOGLE_COORDS)`.
  - Quote conversion (`postgresQuoteConversionRepo.ts`) is **not** touched: its rows stay null (spec E19).
- [ ] **Step 5: Write the failing repo test** (`postgresBookingRepo.legs.test.ts`, local test DB): a trip booking created with identities writes `to_place_id='fake_casa_selvita'` and catalogue `from_lat/from_lng` on leg 1; a booking without identities writes all nulls, exactly as today.
- [ ] **Step 6: Run and see them PASS;** then run the full gate (`DATABASE_URL_TEST` local).
- [ ] **Step 7: Commit** by path: `git commit -m "feat(booking-legs): keep the picked place id on each leg (migration 0074)"`.
- [ ] **Step 8: Release note in the PR:** "Migration 0074 applies on staging at merge, and on prod only through the owner's promotion. It is additive and nullable, with no backfill."

---

### Task 8: Ops sees the place that was actually priced

Spec §8.4, G4. Ops UI only.

**Files:**
- Modify: the booking view data source: `api/src/services/opsView.ts` (~:79), or the ops booking detail endpoint. Find which one feeds the booking sheet's legs with `grep -n "booking_legs\|bookingLegs" api/src/routes/admin*.ts api/src/services/opsView.ts`.
- Modify: `api/src/routes/ops-ui.html`, the booking sheet's leg rows. This is the hot file: merge smallest-first and re-sync before pushing.
- Test: the ops view unit test; `web-tests/e2e/ops-*.spec.js` for the booking sheet

- [ ] **Step 1: Write the failing tests.**
  - The ops booking payload exposes per leg `{ fromPlaceId, toPlaceId, fromLat, fromLng, toLat, toLng }` (nulls when absent).
  - The sheet renders an "Open in Maps" link `https://www.google.com/maps/search/?api=1&query=<name>&query_place_id=<id>` for a leg endpoint with an ID.
  - It renders a coordinate link `…query=<lat>,<lng>` when only coordinates exist, and no link when neither does.
- [ ] **Step 2: Label-mismatch badge.** When the ops endpoint resolves an ID through `maps.placeById` (LRU-cached, Task 4a), it returns Google's `name`/`address`/`area` for display. The sheet shows a small "Google: <name>, <area>" line, and a warn badge when `norm(googleName) !== norm(label)` (spec E7). The test uses fake IDs.
- [ ] **Step 3: Implement, run and see it PASS;** then run the full gate.
- [ ] **Step 4: Visual check** in the browser pane on staging ops (reload with `?cb=`; `/ops` is cached). Take a screenshot.
- [ ] **Step 5: Commit** by path: `git commit -m "feat(ops): show the exact place each leg was priced on, with a Maps link"`.

---

### Task 9 (optional): Index hero / search carry the picked place ID

Spec §8.3. **Low value.** `site.js` already sends Google's full prediction text, which resolves well. Do this only if the Task 4b counters show a meaningful `text` share coming from `search.html` entries.

**Files:** `site.js` `choose()` (~:208-217, which also fixes the `placeSource` overwrite bug at ~:324, only if needed for this), `index.html` `goBook` (~:1176-1189), `search.js` `bookUrl` (~:271-294), `booking.js` non-trip parse (~:207-216)

- [ ] **Step 1:** Write a failing e2e: a hero Google pick → `search.html?…&toPid=` → `booking.html?…&toPid=` → the single estimate carries `toPlaceId`.
- [ ] **Step 2:** Implement:
  - call `CH_MAP.resolvePick` on a Google pick in `site.js` and store the ID in `dataset`;
  - pass `fromPid`/`toPid` through `search.html`;
  - `booking.js` seeds `locFromGeo`/`locToGeo` with `{ name, placeId }` from the URL, so Task 6's `spotPlaceId` sends it.
- [ ] **Step 3:** Run the full gate, `npm run stamp`, and commit.

---

## After the plan: verify the incident is closed

- [ ] Use the prod usage counters (Ops Health) a week after Task 5 ships:
  - `pricing.stop.place_id` > 0;
  - the `pricing.unresolved` rate falls;
  - `pricing.stop.text` share is recorded (the input to the spec §13 "retire text" decision).
- [ ] No new `needs_pricing = true` trip drafts with a Google-picked stop. Owner-run SQL, since prod reads need the owner:

```sql
SELECT b.reference, b.created_at, c.note
FROM bookings b JOIN concierge_tasks c ON c.booking_id = b.id
WHERE b.needs_pricing = true AND b.created_at > '<Task 5 release date>'
ORDER BY b.created_at DESC;
```

## Self-review

- **Spec coverage:**

  | Spec item | Task |
  |---|---|
  | §2.4 / G3 | 1 |
  | E10 | 2 |
  | §9 / G2 | 3 |
  | §7 | 0, 4a |
  | §6, §8.1, §8.2, §13 counters, E4/E8/E11/E13/E16/E17 | 4b |
  | §8.3 trip + §8.4 area line | 5 |
  | §8.3 spot fields | 6 |
  | §12 / G4 | 7 |
  | §8.4 ops / E7 | 8 |
  | §8.3 site.js | 9 |
  | §11 safeguard S1 (retry without IDs on 400) | 5, step 7b |
  | §8.5 safeguard S2 (label mismatch flag) | 0 step 4 (go/no-go), 4b step 10b |
  | §11 release order | Global Constraints + 4b step 14 + gates on 5/6 |
  | E1/E2/E12/E14/E18/E19/E20/E21 | No code needed; asserted by the "byte-identical when absent" tests (4b step 11, 5 step 1, 6 step 1) and the untouched existing suites |

- **Names used consistently across tasks:**
  - `ResolvedPlace`, `isPlaceId`, `placeById` (4a);
  - `IdentifiedStop`, `identifyStops`, `StopSource` (4b, consumed by 7);
  - `fromPlaceId`/`toPlaceId`/`stopPlaceIds` (4b API, 5/6 front-end);
  - `pids` (5);
  - `LegIdentity`, `applyLegIdentities`, `legIdentitiesFrom`, `WRITE_GOOGLE_COORDS` (7).
- **Known judgement calls left to the implementer, each bounded by a test:**
  - the exact `engineRequestFor` return-type change (4b step 9, two call sites);
  - which ops endpoint feeds the booking sheet (8, found by grep).
