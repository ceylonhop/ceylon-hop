# Ops booking pane PR 1: header facts and leg details. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the paid vehicle, guests and bags in the booking pane's header. Show every leg with its road and full addresses. Show the customer's checkout note first, so ops read the job before anything else.

**Architecture:** One file changes, `api/src/routes/ops-ui.html`, an inline-script single page. Four pure helpers (`shortPlace`, `roadOf`, `legRows`, `jobFacts`) go in one marked block, extracted and unit-tested by `web-tests/unit/ops-sheet-job.test.js`. The existing render functions call them: `bookingStubHtml`, `legsHtmlFor` and the Trip/Customer blocks in `renderSheet`. Playwright e2e specs drive the real page against a stubbed API.

**Tech Stack:** plain browser JS + CSS inside `ops-ui.html`, Vitest (unit, `loadFn`-style extraction), Playwright (e2e, stubbed `/admin/**` routes).

## Global Constraints

- Front end only (owner, 2026-11-12). No API, schema, migration, pricing or config change.
- Spec: `docs/superpowers/specs/2026-11-12-ops-booking-pane-info-priority-design.md`. This plan is **PR 1** of four (Risks section). PR 1 includes only: the header stub cells (When / Vehicle / Guests / Bags), road labels, addresses on every leg still to run, a leg row for single and shared bookings, and the customer's note moved first.
- **Not in PR 1:** stepper removal, folded sections, wider pane, amber/red exception lines, the map, the ride-board pane, and "May not fit" (it needs the rate card on the bookings view, which hasn't been checked). The ride-board sheet must look unchanged, apart from the shared `.sheet-stub` column widths.
- Road copy, exactly: `no_tolls` → **"No expressway"**; `fastest` → **"Expressway OK"**.
- Empty note copy, exactly: website → **"No note left at checkout."**; any other channel → **"Booked from a WhatsApp quote. That checkout has no note box."** (Verified: only `booking.html` asks "Anything we should know?".)
- Keep `data-testid="sheet-vehicle"` on the element whose text is just the vehicle name (`web-tests/e2e/ops-sheet-vehicle.spec.js` asserts `toHaveText('Van 9 Seat')`).
- Escape every customer-typed or booking-sourced string with the page's `esc()`.
- `ops-ui.html` is the hot file: commit per task, rebase onto `origin/main` before the PR, and never `git add -A`. Stage by path.
- Gate before every commit: `cd web-tests && npx vitest run` plus the task's e2e spec. Before the PR: `cd api && npm run check` and `cd web-tests && npm run test:all`. Both must be green, judged by the runners' own summary lines and exit codes.

---

### Task 0: Branch setup

**Files:** none

- [ ] **Step 1: Rebase the spec branch onto latest main**

```bash
cd /private/tmp/claude-501/-Users-roshenw--claude-spares-spare-n5EXYY/cc699db8-29f2-42b6-93be-eb1e01cddbd3/scratchpad/wt-ops-pane
git fetch origin && git rebase origin/main
git log --oneline -6
```
Expected: the spec/plan commits sit on top of the current `origin/main`. If the worktree is gone, recreate it with `git worktree add -b feat/ops-booking-pane-pr1 <scratchpad>/wt-ops-pane-pr1 origin/main` and cherry-pick the spec commits.

- [ ] **Step 2: Install web-test deps if missing**

```bash
cd web-tests && ls node_modules/.bin/vitest node_modules/.bin/playwright || npm ci
```

---

### Task 1: Pure helpers (`shortPlace`, `roadOf`, `legRows`, `jobFacts`)

**Files:**
- Modify: `api/src/routes/ops-ui.html`: insert a marked block immediately above `function legsHtmlFor(d){`
- Create: `web-tests/unit/ops-sheet-job.test.js`

**Interfaces:**
- Produces:
  - `shortPlace(s: string) → string`: the text before the first comma, trimmed; the whole string if there's no comma.
  - `roadOf(variant: 'fastest'|'no_tolls') → {text: string, cls: 'road'|'road-local'}`
  - `legRows(b: Booking, today: 'YYYY-MM-DD') → Row[]` where `Row = {kind:'gap', n, from, to} | {kind:'leg', n, date: string|null, time: string|null, from, to, via: string[], variant: 'fastest'|'no_tolls'|null, done: boolean, next: boolean}`
  - `jobFacts(b: Booking, vehicle: string|null, serviceType: string|null, legs: Row[]) → {vehicle: {kind:'vehicle', code, chauffeurDays: number|null} | {kind:'shared', seats} | {kind:'missing'}, guests: {total: number|null, adults: number|null, children: number|null}, bags: {asked: boolean, count: number|null}, when: {label: 'When'|'Departs'|'Next leg', date: string|null, k: number|null, m: number|null, start: string|null}}`

- [ ] **Step 1: Write the failing unit test**

Create `web-tests/unit/ops-sheet-job.test.js`:

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The booking pane's job helpers live between two markers in ops-ui.html (house extraction
// pattern: see ops-booking-addons.test.js). They are pure, so they load with no page globals.
function load() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const m = html.match(/\/\* @sheet-job:start[\s\S]*?\/\* @sheet-job:end \*\//);
  if (!m) throw new Error('@sheet-job block not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn { shortPlace, roadOf, legRows, jobFacts };')();
}
const { shortPlace, roadOf, legRows, jobFacts } = load();

const TODAY = '2026-11-16';
const trip = (input) => ({ mode: 'trip', input: { pax: 2, vehicleType: 'car', serviceType: 'private', ...input } });

describe('shortPlace', () => {
  it('keeps the text before the first comma', () => {
    expect(shortPlace('Grand Royal villa Negombo, Saint Joseph Mawatha, Negombo')).toBe('Grand Royal villa Negombo');
  });
  it('keeps a comma-less name whole, and copes with nothing', () => {
    expect(shortPlace('Ella')).toBe('Ella');
    expect(shortPlace('  Kandy  ')).toBe('Kandy');
    expect(shortPlace(undefined)).toBe('');
  });
});

describe('roadOf', () => {
  it('names the toll-free road in ops’ words', () => {
    expect(roadOf('no_tolls')).toEqual({ text: 'No expressway', cls: 'road-local' });
  });
  it('treats every other road as the usual route', () => {
    expect(roadOf('fastest')).toEqual({ text: 'Expressway OK', cls: 'road' });
    expect(roadOf(undefined)).toEqual({ text: 'Expressway OK', cls: 'road' });
  });
});

describe('legRows: trips', () => {
  const b = trip({
    stops: ['Negombo, A', 'Ella, B', 'Panama, C', 'Udawalawe, D'],
    dates: ['2026-11-13', '2026-11-15', '2026-11-18'],
    routeVariants: ['fastest', 'no_tolls', 'fastest'],
  });

  it('marks legs before today done and the first one on or after today next', () => {
    const rows = legRows(b, TODAY);
    expect(rows.map((r) => [r.n, r.done, r.next])).toEqual([[1, true, false], [2, true, false], [3, false, true]]);
  });

  it('carries the road each leg was priced on', () => {
    expect(legRows(b, TODAY).map((r) => r.variant)).toEqual(['fastest', 'no_tolls', 'fastest']);
  });

  it('keeps full stop strings for the addresses', () => {
    expect(legRows(b, TODAY)[2]).toMatchObject({ from: 'Panama, C', to: 'Udawalawe, D', date: '2026-11-18', time: null });
  });

  it('turns a gap into a self-arranged row and never drives it', () => {
    const rows = legRows(trip({ stops: ['A', 'B', 'C'], dates: ['2026-11-20', '2026-11-21'], gaps: [0] }), TODAY);
    expect(rows[0]).toEqual({ kind: 'gap', n: 1, from: 'A', to: 'B' });
    expect(rows[1]).toMatchObject({ kind: 'leg', n: 2, next: true });
  });

  it('folds stops on the way into one leg, and flags it toll-free if any part is', () => {
    const rows = legRows(trip({ stops: ['A', 'B', 'C', 'D'], dates: ['2026-11-20', null, '2026-11-22'], through: [0], routeVariants: ['fastest', 'no_tolls', 'fastest'] }), TODAY);
    expect(rows[0]).toMatchObject({ kind: 'leg', n: 1, from: 'A', to: 'C', via: ['B'], variant: 'no_tolls' });
    expect(rows[1]).toMatchObject({ kind: 'leg', n: 2, from: 'C', to: 'D' });
  });

  it('never marks an undated leg done or next', () => {
    const rows = legRows(trip({ stops: ['A', 'B', 'C'] }), TODAY);
    expect(rows.every((r) => !r.done && !r.next)).toBe(true);
  });
});

describe('legRows: single and shared', () => {
  it('gives a single transfer one row with its time and road', () => {
    const b = { mode: 'single', input: { from: 'CMB Airport, Katunayake', to: 'Kandy, Earl’s', date: '2026-11-20', time: '06:30', routeVariant: 'no_tolls' } };
    expect(legRows(b, TODAY)).toEqual([{ kind: 'leg', n: 1, date: '2026-11-20', time: '06:30', from: 'CMB Airport, Katunayake', to: 'Kandy, Earl’s', via: [], variant: 'no_tolls', done: false, next: true }]);
  });

  it('gives a shared seat its catalogue leg and no road', () => {
    const b = { mode: 'shared', input: { corridorId: 'c1', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-11-24', time: '07:30', seats: 2 } };
    expect(legRows(b, TODAY)[0]).toMatchObject({ from: 'Ella', to: 'Mirissa', time: '07:30', variant: null });
  });

  it('returns nothing for a shared row that never recorded its leg', () => {
    expect(legRows({ mode: 'shared', input: { corridorId: 'c1', date: '2026-11-24', time: '07:30', seats: 1 } }, TODAY)).toEqual([]);
  });
});

describe('jobFacts', () => {
  it('reads a single transfer’s vehicle, adults/children and bags', () => {
    const b = { mode: 'single', input: { from: 'A', to: 'B', adults: 2, children: 1, bags: 4 } };
    const f = jobFacts(b, 'van', null, legRows(b, TODAY));
    expect(f.vehicle).toEqual({ kind: 'vehicle', code: 'van', chauffeurDays: null });
    expect(f.guests).toEqual({ total: 3, adults: 2, children: 1 });
    expect(f.bags).toEqual({ asked: true, count: 4 });
    expect(f.when.label).toBe('When');
  });

  it('says a trip never asked for bags', () => {
    const b = trip({ stops: ['A', 'B'], pax: 3 });
    const f = jobFacts(b, 'car', 'private', legRows(b, TODAY));
    expect(f.bags).toEqual({ asked: false, count: null });
    expect(f.guests).toEqual({ total: 3, adults: null, children: null });
  });

  it('adds the days to a chauffeur guide’s vehicle', () => {
    const b = trip({ stops: ['A', 'B'], serviceType: 'chauffeur', days: 6, driverNights: 5 });
    expect(jobFacts(b, 'car', 'chauffeur', legRows(b, TODAY)).vehicle).toEqual({ kind: 'vehicle', code: 'car', chauffeurDays: 6 });
  });

  it('shows seats, not a vehicle, for a shared booking', () => {
    const b = { mode: 'shared', input: { corridorId: 'c1', date: '2026-11-24', time: '07:30', seats: 2, bags: 2 } };
    const f = jobFacts(b, null, null, legRows(b, TODAY));
    expect(f.vehicle).toEqual({ kind: 'shared', seats: 2 });
    expect(f.when.label).toBe('Departs');
    expect(f.bags).toEqual({ asked: true, count: 2 });
  });

  it('flags a missing vehicle instead of leaving it blank', () => {
    const b = { mode: 'single', input: { from: 'A', to: 'B', adults: 1, children: 0 } };
    expect(jobFacts(b, null, null, legRows(b, TODAY)).vehicle).toEqual({ kind: 'missing' });
  });

  it('reports bags as not recorded on an older row that has no bags field', () => {
    const b = { mode: 'single', input: { from: 'A', to: 'B', adults: 1, children: 0 } };
    expect(jobFacts(b, 'car', null, legRows(b, TODAY)).bags).toEqual({ asked: true, count: null });
  });

  it('switches When to the next leg once a trip is under way', () => {
    const b = trip({ stops: ['A', 'B', 'C', 'D'], dates: ['2026-11-13', '2026-11-15', '2026-11-18'] });
    expect(jobFacts(b, 'car', 'private', legRows(b, TODAY)).when).toEqual({ label: 'Next leg', date: '2026-11-18', k: 3, m: 3, start: '2026-11-13' });
  });

  it('keeps When on a trip that has not started', () => {
    const b = trip({ stops: ['A', 'B', 'C'], dates: ['2026-11-20', '2026-11-22'] });
    expect(jobFacts(b, 'car', 'private', legRows(b, TODAY)).when.label).toBe('When');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web-tests && npx vitest run unit/ops-sheet-job.test.js`
Expected: FAIL with `@sheet-job block not found in ops-ui.html`.

- [ ] **Step 3: Add the helper block**

In `api/src/routes/ops-ui.html`, insert directly above `function legsHtmlFor(d){`:

```js
/* @sheet-job:start: pure helpers for the booking pane's header and leg list (spec
   2026-11-12-ops-booking-pane-info-priority-design.md, PR 1). No DOM and no page globals, so
   web-tests/unit/ops-sheet-job.test.js can load this block on its own. */
function shortPlace(s){
  const t=String(s??'').trim();
  const i=t.indexOf(',');
  return i>0?t.slice(0,i).trim():t;
}
/* Ops ask "expressway or normal?". Sri Lanka's tolled roads are its expressways, so the toll-free
   road IS "no expressway"; Google's usual route may use one where it exists. */
function roadOf(variant){
  return variant==='no_tolls'?{text:'No expressway',cls:'road-local'}:{text:'Expressway OK',cls:'road'};
}
/* One row per leg a driver runs, in the same grouping as bookingLegs.ts privateLegs: a gap is the
   customer's own travel, and through-stops continue one ride. A leg dated before `today` is done;
   the first dated leg on or after it is next; an undated leg is neither. */
function legRows(b,today){
  const inp=b&&b.input;
  if(!inp)return [];
  const ran=(d)=>!!d&&d<today, ahead=(d)=>!!d&&d>=today;
  if(b.mode==='trip'&&Array.isArray(inp.stops)&&inp.stops.length>1){
    const stops=inp.stops,dates=inp.dates||[],gaps=inp.gaps||[],through=inp.through||[],rv=inp.routeVariants||[];
    const lastWire=stops.length-2,rows=[];
    let next=false,n=0;
    for(let i=0;i<=lastWire;){
      n++;
      if(gaps.includes(i)){rows.push({kind:'gap',n,from:stops[i],to:stops[i+1]});i++;continue;}
      let end=i;
      while(end<lastWire&&through.includes(end)&&!gaps.includes(end+1))end++;
      const date=dates[i]||null;
      const isNext=!next&&ahead(date);
      if(isNext)next=true;
      rows.push({kind:'leg',n,date,time:null,from:stops[i],to:stops[end+1],via:stops.slice(i+1,end+1),
        variant:rv.slice(i,end+1).includes('no_tolls')?'no_tolls':'fastest',done:ran(date),next:isNext});
      i=end+1;
    }
    return rows;
  }
  if(b.mode==='single'&&inp.from&&inp.to){
    const date=inp.date||null;
    return [{kind:'leg',n:1,date,time:inp.time||null,from:inp.from,to:inp.to,via:[],
      variant:inp.routeVariant==='no_tolls'?'no_tolls':'fastest',done:ran(date),next:ahead(date)}];
  }
  if(b.mode==='shared'&&inp.fromPlace&&inp.toPlace){
    const date=inp.date||null;
    return [{kind:'leg',n:1,date,time:inp.time||null,from:inp.fromPlace,to:inp.toPlace,via:[],
      variant:null,done:ran(date),next:ahead(date)}];
  }
  return [];
}
/* What ops tell the vehicle coordinator, read off the booking. `vehicle` is the detail
   response's priced tier (null for a shared seat, or when no quote/snapshot names one). */
function jobFacts(b,vehicle,serviceType,legs){
  const inp=(b&&b.input)||{}, mode=b&&b.mode;
  const veh=mode==='shared'?{kind:'shared',seats:inp.seats||0}
    :vehicle?{kind:'vehicle',code:vehicle,chauffeurDays:serviceType==='chauffeur'?(inp.days||null):null}
    :{kind:'missing'};
  const guests=mode==='single'?{total:(inp.adults||0)+(inp.children||0),adults:inp.adults??null,children:inp.children??null}
    :mode==='trip'?{total:inp.pax??null,adults:null,children:null}
    :mode==='shared'?{total:inp.seats??null,adults:null,children:null}
    :{total:null,adults:null,children:null};
  const bags=mode==='trip'?{asked:false,count:null}:{asked:true,count:typeof inp.bags==='number'?inp.bags:null};
  const driven=(legs||[]).filter(l=>l.kind==='leg');
  const nextLeg=driven.find(l=>l.next)||null;
  const when=mode==='trip'&&nextLeg&&driven.some(l=>l.done)
    ?{label:'Next leg',date:nextLeg.date,k:driven.indexOf(nextLeg)+1,m:driven.length,start:(driven.find(l=>l.date)||{}).date||null}
    :{label:mode==='shared'?'Departs':'When',date:null,k:null,m:null,start:null};
  return {vehicle:veh,guests,bags,when};
}
/* @sheet-job:end */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web-tests && npx vitest run unit/ops-sheet-job.test.js`
Expected: PASS, every test in the file (read the runner's summary line).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/unit/ops-sheet-job.test.js
git commit -m "feat(ops): pure job helpers for the booking pane header and legs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Header stub shows When, Vehicle, Guests, Bags

**Files:**
- Modify: `api/src/routes/ops-ui.html`: `bookingStubHtml`, its call in `renderSheet`, the `vehicleRow` in the Trip block, and `.stub` / `.sheet-stub` CSS
- Create: `web-tests/e2e/ops-sheet-job.spec.js`

**Interfaces:**
- Consumes: `legRows`, `jobFacts` (Task 1); page globals `TODAY`, `VEHICLE_NAME`, `fmtDate`, `esc`
- Produces: `bookingStubHtml(t, d)`, with `d` possibly null while the detail loads. Test ids: `sheet-when`, `sheet-vehicle` (vehicle name only), `sheet-seats`, `sheet-vehicle-missing`, `sheet-guests`, `sheet-bags`.

- [ ] **Step 1: Write the failing e2e spec**

Create `web-tests/e2e/ops-sheet-job.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Spec 2026-11-12 (booking pane, PR 1): the header answers "what do I tell the coordinator?"
// before any scrolling: the vehicle the customer PAID for, the party, the bags. A van booking
// was once sent a car because the header showed only "3 guests".

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const CUSTOMER = { whatsapp: '+94 77 000 0000', email: 'c@example.com', country: 'Spain' };

const row = (id, ref, mode, extra = {}) => ({
  id, reference: ref, channel: 'website', customerName: 'Alpha Customer', customerFirstName: 'Alpha',
  mode, route: 'A → B', travelDate: futureIsoDate(30), travelTime: '09:00', pax: 3,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null, ...extra,
});
const detail = (id, ref, mode, input, vehicle, extra = {}) => ({
  payLink: null, vehicle,
  booking: { id, reference: ref, currency: 'USD', status: 'paid', mode, createdAt: '2026-09-01T00:00:00Z', input: { customer: CUSTOMER, ...input }, ...extra },
  ops: { updatedAt: '2026-09-02T00:00:00Z' },
  payments: [{ id: 'p1', status: 'succeeded', amount: 3900, currency: 'USD' }],
  refunds: [],
});

const D = (n) => futureIsoDate(n);
const BOOKINGS = {
  van: [row('van', 'CH-0001', 'single'), detail('van', 'CH-0001', 'single',
    { from: 'Colombo Airport (CMB), Katunayake', to: 'Kandy, Earl’s Regency', date: D(30), time: '06:30', vehicleType: 'van', adults: 2, children: 1, bags: 4, routeVariant: 'no_tolls' }, 'van')],
  trip: [row('trip', 'CH-0002', 'trip', { serviceType: 'private' }), detail('trip', 'CH-0002', 'trip',
    { stops: ['Negombo, Grand Royal villa', 'Ella, Senasuma Inn', 'Panama, Vista Villa'], dates: [D(30), D(32)], pax: 2, vehicleType: 'car', serviceType: 'private' }, 'car')],
  mid: [row('mid', 'CH-0003', 'trip', { serviceType: 'private', travelDate: D(-5) }), detail('mid', 'CH-0003', 'trip',
    { stops: ['Negombo, A', 'Ella, B', 'Panama, C', 'Udawalawe, D'], dates: [D(-5), D(-3), D(3)], pax: 2, vehicleType: 'car', serviceType: 'private' }, 'car')],
  chauffeur: [row('chauffeur', 'CH-0004', 'trip', { serviceType: 'chauffeur' }), detail('chauffeur', 'CH-0004', 'trip',
    { stops: ['Colombo, X', 'Kandy, Y'], dates: [D(30)], pax: 2, vehicleType: 'car', serviceType: 'chauffeur', days: 6, driverNights: 5 }, 'car')],
  shared: [row('shared', 'CH-0005', 'shared'), detail('shared', 'CH-0005', 'shared',
    { corridorId: 'c1', fromPlace: 'Ella', toPlace: 'Mirissa', date: D(30), time: '07:30', seats: 2, bags: 2 }, null)],
  novehicle: [row('novehicle', 'CH-0006', 'single'), detail('novehicle', 'CH-0006', 'single',
    { from: 'A, x', to: 'B, y', date: D(30), time: '09:00', vehicleType: 'car', adults: 1, children: 0 }, null)],
};

async function boot(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Catch-all first: Playwright gives precedence to the LAST matching route.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(Object.values(BOOKINGS).map(([rw]) => rw))));
  for (const [id, [, d]] of Object.entries(BOOKINGS)) {
    await page.route(`**/admin/ops/bookings/${id}`, (r) => r.fulfill(json(d)));
  }
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

async function open(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}
const stub = (page) => page.locator('#sheet .sheet-stub');

test('the header names the vehicle paid for, beside the party and the bags', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(stub(page).getByTestId('sheet-vehicle')).toHaveText('Van 6 Seat');
  await expect(stub(page).locator('.stub-veh .ss').first()).toHaveText('paid for');
  await expect(stub(page).getByTestId('sheet-guests')).toHaveText('3');
  await expect(stub(page).locator('.stub', { has: page.getByTestId('sheet-guests') }).locator('.ss')).toHaveText('2 adults · 1 child');
  await expect(stub(page).getByTestId('sheet-bags')).toHaveText('4');
  await expect(stub(page).getByTestId('sheet-when')).toContainText(/\d/);
  // The total left the header: money isn't what ops tell the coordinator.
  await expect(stub(page)).not.toContainText('Total');
  // One vehicle on the pane, in the header: the old Trip-block row is gone.
  await expect(page.locator('#sheet [data-testid="sheet-vehicle"]')).toHaveCount(1);
});

test('a trip says bags were never asked', async ({ page }) => {
  await boot(page);
  await open(page, 'trip');
  await expect(stub(page).getByTestId('sheet-vehicle')).toHaveText('Car');
  await expect(stub(page).getByTestId('sheet-bags')).toHaveText('—');
  await expect(stub(page).locator('.stub', { has: page.getByTestId('sheet-bags') }).locator('.ss')).toHaveText('not asked');
});

test('a trip under way shows its next leg in the header', async ({ page }) => {
  await boot(page);
  await open(page, 'mid');
  const when = stub(page).locator('.stub', { has: page.getByTestId('sheet-when') });
  await expect(when.locator('.sl')).toHaveText('Next leg');
  await expect(when.locator('.ss')).toContainText('leg 3 of 3 · started');
});

test('a chauffeur guide shows the driver and the days', async ({ page }) => {
  await boot(page);
  await open(page, 'chauffeur');
  await expect(stub(page).locator('.stub-veh .sv')).toHaveText('Car + driver');
  await expect(stub(page).locator('.stub-veh .ss').first()).toHaveText('paid for · 6 days');
});

test('a shared seat shows seats, not a vehicle', async ({ page }) => {
  await boot(page);
  await open(page, 'shared');
  await expect(stub(page).getByTestId('sheet-seats')).toHaveText('2 shared seats');
  await expect(stub(page).getByTestId('sheet-vehicle')).toHaveCount(0);
  await expect(stub(page).locator('.stub', { has: page.getByTestId('sheet-when') }).locator('.sl')).toHaveText('Departs');
});

test('a booking with no vehicle on record says so, never blank', async ({ page }) => {
  await boot(page);
  await open(page, 'novehicle');
  await expect(stub(page).getByTestId('sheet-vehicle-missing')).toHaveText('Not on record');
});

test('on a phone the vehicle cell carries the party and bags', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await open(page, 'van');
  await expect(stub(page).locator('.stub-veh .ss-narrow')).toBeVisible();
  await expect(stub(page).locator('.stub-veh .ss-narrow')).toHaveText('3 guests · 4 bags');
  await expect(stub(page).getByTestId('sheet-guests')).toBeHidden();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-job.spec.js`
Expected: FAIL. The first test can't find `#sheet .sheet-stub [data-testid="sheet-vehicle"]`, because today the vehicle is a `.kv` row in the body.

- [ ] **Step 3: Replace `bookingStubHtml` and pass the detail to it**

Replace the whole `function bookingStubHtml(t){ ... }` with:

```js
/* The header answers "what do I tell the coordinator?" (spec 2026-11-12): when, the vehicle the
   customer PAID for, the party, the bags. Money left the header; the Payment block carries it.
   `d` is null while the detail loads, so the cells it alone knows shimmer instead of guessing. */
function bookingStubHtml(t,d){
  const cell=(cls,label,value,sub,tid,extra='')=>`<div class="stub${cls}"><div class="sl">${label}</div><div class="sv"${tid?` data-testid="${tid}"`:''}>${value}</div>${sub!=null?`<div class="ss">${sub}</div>`:''}${extra}</div>`;
  const sk='<span class="sk-inline" aria-hidden="true"></span>';
  const b=d?.booking||null;
  const f=b?jobFacts(b,d.vehicle||null,t.serviceType,legRows(b,TODAY)):null;
  const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
  const when=f&&f.when.label==='Next leg'
    ?cell('','Next leg',esc(fmtDate(f.when.date)),`leg ${f.when.k} of ${f.when.m}${f.when.start?' · started '+esc(fmtDate(f.when.start)):''}`,'sheet-when')
    :cell('',f?f.when.label:'When',t.date?esc(fmtDate(t.date)):'Flexible',t.time?esc(t.time):'time not set','sheet-when');
  const g=f?.guests, bg=f?.bags;
  const guestsSub=!g?null:g.adults!=null&&g.children!=null
    ?plural(g.adults,'adult','adults')+(g.children>0?' · '+plural(g.children,'child','children'):'')
    :'guests';
  const guestsN=g?g.total:t.guests;
  const bagsSub=!bg?null:!bg.asked?'not asked':bg.count==null?'not recorded':bg.count===1?'bag':'bags';
  /* Phones keep two cells (When, Vehicle), so the party rides under the vehicle there. */
  const narrow=f?`<div class="ss ss-narrow">${guestsN==null?'guests not recorded':plural(guestsN,'guest','guests')} · ${!bg.asked?'bags not asked':bg.count==null?'bags not recorded':plural(bg.count,'bag','bags')}</div>`:'';
  let veh;
  if(!f)veh=cell(' stub-veh','Vehicle',sk,null);
  else if(f.vehicle.kind==='shared')veh=cell(' stub-veh','Seats',esc(plural(f.vehicle.seats,'shared seat','shared seats')),'no vehicle to choose','sheet-seats',narrow);
  else if(f.vehicle.kind==='missing')veh=cell(' stub-veh stub-missing','Vehicle','Not on record','check the quote','sheet-vehicle-missing',narrow);
  else veh=cell(' stub-veh','Vehicle',`<span data-testid="sheet-vehicle">${esc(VEHICLE_NAME[f.vehicle.code]||f.vehicle.code)}</span>${f.vehicle.chauffeurDays?' + driver':''}`,
    f.vehicle.chauffeurDays?`paid for · ${esc(String(f.vehicle.chauffeurDays))} days`:'paid for',null,narrow);
  const guests=cell('','Guests',guestsN==null?'—':esc(String(guestsN)),guestsSub,'sheet-guests');
  const bags=f?cell('','Bags',bg.count==null?'—':esc(String(bg.count)),bagsSub,'sheet-bags'):cell('','Bags',sk,null);
  return when+veh+guests+bags;
}
```

In `renderSheet`, change the `sheetHeadHtml(t,{...})` argument `stub:bookingStubHtml(t)` to `stub:bookingStubHtml(t,d)`. `d` is already in scope above it: `const d=state.detailData;`.

- [ ] **Step 4: Drop the Trip block's vehicle row**

In `renderSheet`, delete these two lines (the comment and the const):

```js
  /* The vehicle the trip was priced on (the API reads the tier off the quote or the website's
     snapshot — the booking alone only knows car|van). Absent for a shared seat. */
  const vehicleRow=d?.vehicle?`<div class="kv"><span class="k">Vehicle</span><span class="v" data-testid="sheet-vehicle">${esc(VEHICLE_NAME[d.vehicle]||d.vehicle)}</span></div>`:'';
```

and delete the line `        ${vehicleRow}` in the Trip block.

- [ ] **Step 5: CSS: cells wrap, the vehicle cell is outlined, phones get the party line**

Replace the `.stub .sv{...}` rule (today it ends `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px}`) with:

```css
  .stub .sv{font-family:var(--mono);font-weight:700;font-size:.84rem;margin-top:3px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;display:flex;flex-wrap:wrap;align-items:center;gap:0 6px}
  .stub .ss{font-size:.68rem;color:var(--ink-soft);margin-top:2px;line-height:1.3;overflow-wrap:anywhere}
  /* The vehicle paid for: an ink outline and bigger type, never a teal fill (teal = a button). */
  .stub.stub-veh{box-shadow:inset 0 0 0 2px var(--ink);background:var(--paper)}
  .stub.stub-veh .sl{color:var(--ink)}
  .stub.stub-veh .sv{font-size:1rem}
  .stub.stub-missing{box-shadow:inset 0 0 0 2px var(--alert)}
  .stub.stub-missing .sl,.stub.stub-missing .sv{color:var(--alert)}
  .stub .ss-narrow{display:none}
  .stub .sk-inline{display:inline-block;width:70%;height:13px;border-radius:6px;background:var(--line-soft)}
```

Change `.sheet-stub{display:grid;grid-template-columns:1.02fr 1.08fr .62fr .95fr;` to `.sheet-stub{display:grid;grid-template-columns:1fr 1.3fr .7fr .7fr;` (keep the rest of that rule).

Change the phone rule `@media(max-width:700px){.sheet-stub{grid-template-columns:1.3fr 1fr}.stub:nth-child(3),.stub:nth-child(4){display:none}}` to:

```css
  @media(max-width:700px){.sheet-stub{grid-template-columns:1fr 1.3fr}.stub:nth-child(3),.stub:nth-child(4){display:none}.stub .ss-narrow{display:block}}
```

- [ ] **Step 6: Run the new spec and the specs this touches**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-job.spec.js e2e/ops-sheet-vehicle.spec.js`
Expected: PASS (all tests). `ops-sheet-vehicle.spec.js` stays green unchanged: its `sheet-vehicle` now lives in the header and still reads "Van 9 Seat", and its shared test checks that no `.kv` "Vehicle" row exists.

- [ ] **Step 7: Check that nothing else read the old stub**

Run: `cd web-tests && grep -rn -E "Total</|\.sheet-stub|\.stub \.sv|paych" e2e | grep -v ops-sheet-job`
Expected: no booking-sheet assertion on the old Total/Travel/Type cells. For each hit, open it, and if it asserts the booking stub's Total or Type, update it to read the Payment block's Amount row instead. The ride-board stub (`boardStubHtml`) is unchanged.

- [ ] **Step 8: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-sheet-job.spec.js
git commit -m "feat(ops): booking pane header shows the vehicle paid for, guests and bags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Every leg shows its road and, until it has run, its addresses

**Files:**
- Modify: `api/src/routes/ops-ui.html`: `legsHtmlFor`, the Trip block's Route and Road rows, and `.legs` CSS
- Modify: `web-tests/e2e/ops-sheet-job.spec.js` (append tests)

**Interfaces:**
- Consumes: `shortPlace`, `roadOf`, `legRows` (Task 1); globals `TODAY`, `fmtDate`, `esc`
- Produces: leg markup `.legs .leg[data-leg="<n>"]` with `.lt` (line) and `.addr` (addresses). The road is `[data-testid="leg-road"]`.

- [ ] **Step 1: Append the failing e2e tests**

Append to `web-tests/e2e/ops-sheet-job.spec.js`:

```js
test('a toll-free leg says "No expressway"', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(page.locator('#sheet .legs [data-testid="leg-road"]')).toHaveText(['No expressway']);
});

test('every other leg says "Expressway OK"', async ({ page }) => {
  await boot(page);
  await open(page, 'trip');
  await expect(page.locator('#sheet .legs [data-testid="leg-road"]')).toHaveText(['Expressway OK', 'Expressway OK']);
});

test('every leg still to run shows its full addresses; a leg that ran shrinks to one line', async ({ page }) => {
  await boot(page);
  await open(page, 'mid');
  const legs = page.locator('#sheet .legs .leg');
  await expect(legs).toHaveCount(3);
  await expect(legs.nth(0)).toHaveClass(/leg-done/);
  await expect(legs.nth(0).locator('.addr')).toHaveCount(0);
  await expect(legs.nth(2)).toHaveClass(/leg-next/);
  await expect(legs.nth(2).locator('.addr')).toContainText('Panama, C');
  await expect(legs.nth(2).locator('.addr')).toContainText('Udawalawe, D');
  await expect(legs.nth(2).locator('.lt')).toContainText('Panama → Udawalawe');
});

test('a single transfer gets a leg row with its time, not "no leg breakdown"', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(page.locator('#sheet .legs .leg .lt')).toContainText('Colombo Airport (CMB) → Kandy');
  await expect(page.locator('#sheet .legs .leg .lt')).toContainText('06:30');
  await expect(page.locator('#sheet .sheet-b')).not.toContainText('no leg breakdown');
});

test('a shared seat gets its catalogue leg and no road label', async ({ page }) => {
  await boot(page);
  await open(page, 'shared');
  await expect(page.locator('#sheet .legs .leg .lt')).toContainText('Ella → Mirissa');
  await expect(page.locator('#sheet .legs [data-testid="leg-road"]')).toHaveCount(0);
});

test('the route is said once: no separate Route or Road row', async ({ page }) => {
  await boot(page);
  await open(page, 'van');
  await expect(page.locator('#sheet .sheet-b .kv .k', { hasText: /^(Route|Road)$/ })).toHaveCount(0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-job.spec.js -g "leg|route is said once"`
Expected: FAIL. No `[data-testid="leg-road"]` exists yet, and the single transfer still says "Single transfer — no leg breakdown."

- [ ] **Step 3: Rewrite `legsHtmlFor` on top of `legRows`**

Replace the whole `function legsHtmlFor(d){ ... }` with:

```js
function legsHtmlFor(d){
  const b=d?.booking;
  /* Partial pay link (spec 2026-08-04): same sentence the customer's email carries. */
  const cov=d?.coverage
    ? `<div class="legs-coverage">Covers ${d.coverage.soldLegs} of ${d.coverage.totalLegs} quoted legs — travel between them is the customer's own arrangement.</div>`
    : '';
  const rows=b?legRows(b,TODAY):[];
  if(!rows.length)return cov+'<div style="color:var(--ink-faint);font-size:.88rem">No leg breakdown on record for this booking.</div>';
  /* One line per leg (spec 2026-11-12): date · short places · road. A leg still to run also
     shows its full addresses, so a whole trip can be briefed to one coordinator in one go; a leg
     that has run (dated before today) shrinks to its struck-out line. */
  const html=rows.map(r=>{
    const places=`<span title="${esc(r.from)} → ${esc(r.to)}">${esc(shortPlace(r.from))} → ${esc(shortPlace(r.to))}</span>`;
    if(r.kind==='gap')return `<div class="leg leg-gap" data-leg="${r.n}"><div class="lt"><span class="r">${places} · customer’s own travel, not driven by us</span></div></div>`;
    const when=r.date?fmtDate(r.date)+(r.time?' · '+r.time:''):(b.mode==='trip'?`Leg ${r.n}`:'Date not set');
    const via=r.via.length?` <span class="via">via ${r.via.map(v=>esc(shortPlace(v))).join(', ')}</span>`:'';
    const road=r.variant?roadOf(r.variant):null;
    const st=r.done?' leg-done':r.next?' leg-next':'';
    const addr=r.done?'':`<div class="addr"><b>From</b><span>${esc(r.from)}</span><b>To</b><span>${esc(r.to)}</span></div>`;
    return `<div class="leg${st}" data-leg="${r.n}"><div class="lt"><span class="r">${esc(when)} · ${places}${via}</span>${road?`<span class="${road.cls}" data-testid="leg-road">${road.text}</span>`:''}</div>${addr}</div>`;
  }).join('');
  return cov+`<div class="legs">${html}</div>`;
}
```

- [ ] **Step 4: Drop the Route and Road rows from the Trip block**

In `renderSheet`'s Trip block, delete these two lines:

```js
        <div class="kv"><span class="k">Route</span><span class="v">${esc(t.route)}</span></div>
        ${d?.booking?.mode==='single'&&d.booking.input?.routeVariant==='no_tolls'?`<div class="kv"><span class="k">Road</span><span class="v">Local road, no expressway</span></div>`:''}
```

Then move the legs to the top of the block. Change the block's tail `<div style="margin-top:10px">${legsHtmlFor(d)}</div>` to nothing, and put `<div style="margin-bottom:6px">${legsHtmlFor(d)}</div>` straight after `<div class="block"><h4>Trip</h4>`.

- [ ] **Step 5: CSS for the new leg line**

Replace the rule starting `.legs{font-size:.88rem}.legs .leg{display:flex;justify-content:space-between;padding:7px 0;...` (keep `.legs .leg:first-child{border-top:0}` and the `.p` rule that follow on the same lines) by changing only `.legs .leg{display:flex;justify-content:space-between;` to `.legs .leg{display:block;`. Then add after the `.legs .leg-next .r::after{...}` rule:

```css
  .legs .lt{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .legs .lt .r{min-width:0}
  .legs .via{color:var(--ink-soft);font-weight:400}
  .legs .road{flex:none;font-size:.74rem;color:var(--ink-faint);white-space:nowrap}
  .legs .road-local{flex:none;font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--wait-bg);color:var(--wait);white-space:nowrap}
  .legs .addr{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1px 8px;margin-top:4px;font-size:.8rem;color:var(--ink-soft);overflow-wrap:anywhere}
  .legs .addr b{font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);padding-top:2px}
```

- [ ] **Step 6: Run the specs**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-job.spec.js e2e/ops-sheet-vehicle.spec.js e2e/ops-road.spec.js`
Expected: PASS. `ops-road.spec.js` asserts the queue row's `.tk-road` and the Lookup header's Road row, neither of which this changes.

- [ ] **Step 7: Find any other spec that read the old leg markup**

Run: `cd web-tests && grep -rln -E "no leg breakdown|\.legs|leg-next|leg-done|local road'" e2e | grep -v ops-sheet-job | xargs -r npx playwright test`
Expected: PASS. If a test asserted the old `"<date> · A → B · local road"` single-span text, update it to read `.lt` and `[data-testid="leg-road"]`. Note the change in the commit message.

- [ ] **Step 8: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-sheet-job.spec.js
git commit -m "feat(ops): every leg shows its road and, until it has run, its addresses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The customer's checkout note comes first

**Files:**
- Modify: `api/src/routes/ops-ui.html`: `renderSheet` (`noteRow` → a note block placed first) and CSS
- Modify: `web-tests/e2e/ops-sheet-customer-note.spec.js`

**Interfaces:**
- Consumes: `t.chan` ('website' | 'whatsapp'), `d.booking.customerNotes`
- Produces: `[data-testid="sheet-customer-note"]` block, the first `.block` in `.sheet-b` (after "Next up" when unpaid), with `.cust-note` holding the text.

- [ ] **Step 1: Update the existing note spec to the new place (failing)**

In `web-tests/e2e/ops-sheet-customer-note.spec.js`, replace the two tests at the bottom with:

```js
test("the booking sheet shows the customer's note first, as plain text", async ({ page }) => {
  await boot(page);
  await open(page, 'b1');
  const block = page.getByTestId('sheet-customer-note');
  await expect(block.locator('.cust-note')).toHaveText(NOTE);
  // The markup arrived as characters, not as an element that ran.
  await expect(block.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  // It opens the body, ahead of the trip and the customer's contact details.
  await expect(page.locator('.sheet-b > .block').first()).toHaveAttribute('data-testid', 'sheet-customer-note');
  // Said once: the old Note row in the Customer block is gone.
  await expect(page.locator('.sheet-b .kv .k', { hasText: /^Note$/ })).toHaveCount(0);
});

test('a website booking with no note says none was left', async ({ page }) => {
  await boot(page);
  await open(page, 'b2');
  const block = page.getByTestId('sheet-customer-note');
  await expect(block.locator('.cust-note')).toHaveCount(0);
  await expect(block).toContainText('No note left at checkout.');
});
```

Add a third booking to this spec for the WhatsApp case. In `boot`, add `row('b3', 'CH-0003', 'Charlie Customer')` with `channel: 'whatsapp'` to the list:

```js
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([
    row('b1', 'CH-0001', 'Alpha Customer'), row('b2', 'CH-0002', 'Bravo Customer'),
    { ...row('b3', 'CH-0003', 'Charlie Customer'), channel: 'whatsapp' },
  ])));
  await page.route('**/admin/ops/bookings/b3', (r) => r.fulfill(json(detail('b3', null))));
```

Then append:

```js
test('a WhatsApp-quote booking explains why there is no note', async ({ page }) => {
  await boot(page);
  await open(page, 'b3');
  await expect(page.getByTestId('sheet-customer-note')).toContainText('Booked from a WhatsApp quote. That checkout has no note box.');
});
```

(`detail()` sets `reference` to `'CH-0002'` for any id that isn't `b1`. That's fine here, since nothing asserts b3's reference.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-customer-note.spec.js`
Expected: FAIL, because `getByTestId('sheet-customer-note')` doesn't exist yet.

- [ ] **Step 3: Replace the note row with a first block**

In `renderSheet`, replace:

```js
  /* What the customer wrote in the booking page's "Anything we should know?" box. Typed by the
     public, so it is escaped like every other value here; pre-line keeps their line breaks. */
  const custNote=d?.booking?.customerNotes;
  const noteRow=custNote?`<div class="kv"><span class="k">Note</span><span class="v" style="white-space:pre-line">${esc(custNote)}</span></div>`:'';
```

with:

```js
  /* What the customer wrote in the booking page's free-form "Anything we should know?" box: often
     a job fact (a surfboard, a pram, the hotel gate), so it opens the body (spec 2026-11-12). Typed
     by the public, so it is escaped; pre-line keeps their line breaks; never cut short. Only the
     website checkout has the box, so a WhatsApp-quote booking says why there is none. */
  const custNote=d?.booking?.customerNotes;
  const noteBlock=`<div class="block" data-testid="sheet-customer-note"><h4>Customer’s note</h4>${custNote
    ?`<div class="cust-note">${esc(custNote)}</div>`
    :`<p class="muted" style="padding:0;margin:0">${t.chan==='website'?'No note left at checkout.':'Booked from a WhatsApp quote. That checkout has no note box.'}</p>`}</div>`;
```

Then in the body template, change `${pendingBlock}` to `${pendingBlock}${noteBlock}`, and delete `        ${noteRow}` from the Customer block.

- [ ] **Step 4: CSS**

Add near the other `.block` rules:

```css
  .cust-note{white-space:pre-line;overflow-wrap:anywhere;padding:10px 13px;border-radius:10px;background:var(--wait-bg);color:var(--ink);font-size:.92rem;line-height:1.5}
```

- [ ] **Step 5: Run the specs**

Run: `cd web-tests && npx playwright test e2e/ops-sheet-customer-note.spec.js e2e/ops-sheet-job.spec.js`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-sheet-customer-note.spec.js
git commit -m "feat(ops): the customer's checkout note opens the booking pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full gate, visual check, PR

**Files:** none new

- [ ] **Step 1: Rebase onto latest main**

```bash
git fetch origin && git rebase origin/main
```
If `ops-ui.html` conflicts, resolve by keeping main's version of the conflicting hunk plus this PR's change. Re-run Steps 2–3 after any conflict.

- [ ] **Step 2: Web gate**

Run: `cd web-tests && npm run test:all; echo "exit=$?"`
Expected: the vitest summary line shows 0 failed, the Playwright summary shows 0 failed, and `exit=0`. Under load, check `uptime` first and rerun once if a flake looks load-related (memory: local gate flakes under load).

- [ ] **Step 3: API gate**

Run: `cd api && npm run check; echo "exit=$?"`
Expected: `exit=0`. This needs `DATABASE_URL_TEST` set to the local test Postgres. Never point it at `api/.env`'s `DATABASE_URL`, which is prod.

- [ ] **Step 4: Visual check, five states**

Write a throwaway script in the scratchpad (not committed) that imports `web-tests/node_modules/playwright/index.mjs`. It should serve the repo the way `web-tests/playwright.config.js` does, reuse `ops-sheet-job.spec.js`'s `BOOKINGS` and `boot`, open `van`, `trip`, `mid`, `shared` and `novehicle` at 1280×800 and at 390×844, and save `page.locator('#sheet').screenshot()` per state. Then look at each PNG and check:
- the vehicle cell is outlined, not teal
- nothing in the header is cut off with "…"
- the addresses wrap
- the note is the first block
- the phone vehicle cell shows "3 guests · 4 bags"

Fix anything off, rerun Step 2, and commit.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "Ops booking pane: vehicle, party and bags in the header; road and addresses on every leg; note first" --body "$(cat <<'EOF'
PR 1 of 4 from docs/superpowers/specs/2026-11-12-ops-booking-pane-info-priority-design.md.

Why: a booking paid as a van was sent a car. The header showed "3 guests" and the vehicle sat
under a long route paragraph. Ops also asked whether each leg is expressway or not.

What changes (front end only, api/src/routes/ops-ui.html):
- Header: When (or Next leg once a trip is under way) · Vehicle paid for (outlined; "Not on
  record" when missing; seats for a shared booking; "+ driver · N days" for chauffeur) · Guests
  (adults/children for transfers) · Bags ("not asked" on trips). The total moves out of the
  header; it is in the Payment block.
- Legs: one line each with "Expressway OK" or "No expressway"; full addresses on every leg still
  to run; single transfers and shared seats get a leg row; the duplicate Route/Road rows are gone.
- The customer's checkout note opens the body; a WhatsApp-quote booking says why there's none.

Not in this PR: stepper, folds, wider pane, amber/red lines, map, ride-board pane (PRs 2–4).

Tests: web-tests/unit/ops-sheet-job.test.js (helpers), web-tests/e2e/ops-sheet-job.spec.js (new),
web-tests/e2e/ops-sheet-customer-note.spec.js (updated). Red→green evidence: <paste the Task 1
Step 2 and Task 2 Step 2 failure lines and the final summary lines>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then bind the PR with the ccd_pr tools and read its CI. Never poll CI by hand, and never enable auto-merge unless the owner asks. Merging to `main` deploys `ops.staging`. Prod needs the owner's promote.

---

## Self-review notes

- **Spec coverage (PR 1 scope):**
  - header cells, per-type overrides, and mid-trip header → Task 2
  - road copy, every upcoming leg's addresses, undated legs, gaps, through-stops → Tasks 1 and 3
  - note first with exact empty copy → Task 4
  - phone party line → Task 2
  - vehicle outline and wrapping → Task 2
  - "May not fit" is deferred, by decision (Global Constraints).
- **Correction to the design page:** mockup E shows hotel names ("98 Acres Resort") for a shared seat. `SharedInput` has no hotel field: `fromPlace`/`toPlace` are catalogue towns and hotel pick-up is only an add-on. So PR 1 shows the towns, and a hotel appears only if the customer put it in their note.
