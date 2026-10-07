# Partner experiences near the drop-off — design

Date: 2026-10-06 · Owner: Roshen · Status: draft for owner review
Facts below were read from `origin/main` (925e3887 / 06caf849) on 2026-10-06; file:line cites are to that tree.

## 1. What this is

A new line of business. Ceylon Hop has negotiated deals with local businesses near the places we
drop customers off (Atherya — Ayurvedic massage, Suwee — village cooking lesson, a Minneriya jeep
safari, all near Sigiriya). When a customer is going somewhere we have partners, we show those
**experiences** and let them tap **"I'm interested"**. Nothing is charged. The Ceylon Hop Pro
team then reaches out and arranges it by hand, at the same price as booking direct.

It is **lead capture, not a booking engine** (owner, 2026-10-06). The website records interest; ops
turns it into a booking off-platform.

### Phases

| Phase | What | This spec |
|---|---|---|
| 1 | Catalogue in the DB, ops page to maintain it, shown on the booking page **and** the customer quote page, "I'm interested" recorded and worked by ops | **Designed here, built by the plan** |
| 2 | Pre-travel email: closer to the travel date, customers who did **not** pick any experience get one email with the top experiences + guides for their stops | Own spec, after phase 1 has live data |
| 3 | Paid experiences: price becomes a charged line, slot choice, partner payout | Not built; §9 records what phase 1 does now so phase 3 is additive |

**Why phase it this way:** phase 2 needs phase 1's data ("who did *not* pick one" is a query on
phase 1's table), and phase 3 needs evidence that people want these before we take money for
them. Building 1 first keeps each step shippable on its own.

## 2. User stories (phase 1)

**Traveller**
- T1. Booking a transfer to Sigiriya, I see what I can do near my drop-off, so I can plan without searching elsewhere.
- T2. I see the price, duration, open days/times, details and photos, so I can judge it.
- T3. I tap "I'm interested" without paying or committing; it is unmistakable that nothing is charged.
- T4. I'm told I won't pay more than booking direct and that the Pro team will reach out.
- T5. On a quote link sent by ops, I see the same experiences for the places in my quote and can tap "I'm interested" there too.
- T6. My confirmation email reminds me what I said I'm interested in.

**Ops**
- O1. I add/edit an experience (name, partner, price, days, times, details, photos, location, reach) without a developer.
- O2. I switch an experience off without deleting it (partner closed for the season).
- O3. I see every open interest in one queue (customer, booking/quote ref, travel date, place) and on the booking/quote itself.
- O4. I move each interest through new → contacted → booked / declined, with a note.

**Owner**
- W1. I can see which experiences draw interest and which convert (statuses + counts on the ops page).

## 3. Decisions (each with its reason)

### D1 — Lead capture only; the total never changes
The tap records interest; there is no slot choice and no payment.
**Why:** owner call (2026-10-06): "lightweight… we manage via ops everything else". It also keeps
checkout, pricing and PayHere completely untouched, which is where this codebase carries its risk.

### D2 — Called "experiences" in code and in the ops tool
**Why:** "add-ons"/"extras" already mean the sightseeing/waiting fees — `EXTRA_CODES`
(`api/src/quote/rateCard.ts:4`), `state.addons` and `toggleAddon` (`booking.js:288`, `:1339`).
A second meaning of the same word guarantees a mix-up in code review and in ops conversations.
Customers never see the word; they see "While you're in Sigiriya".

### D3 — Two new tables, not a reuse of an existing record
`experiences` (the catalogue) and `experience_interests` (one row per customer × experience).
**Why not reuse:**
- `bookings.customer_notes` (`schema.ts:82`) is free text; ops can't track a status per experience, and phase 2 can't query it.
- `concierge_tasks` (`schema.ts:269`) has no link to an experience or a quote, and nothing in the ops tool lists it today.
- A JSON column on `bookings` can't hold interests made on a **quote** before any booking exists (T5).
A table per concept is also exactly how phase 3 grows (an interest becomes a paid line).

### D4 — What an experience stores
| Field | Type | Why |
|---|---|---|
| `slug` | text, unique, `^[a-z0-9-]{3,60}$` | stable id for photos and links |
| `name`, `partner_name` | text ≤ 80 | shown on the card |
| `summary` | text ≤ 160 | the one-liner on the card |
| `details` | text ≤ 2000, plain | "package details" in the Details panel |
| `price_cents` + `currency` (`'USD'` check) | integer + text | project money rule: integer minor units + ISO currency (CLAUDE.md "Stack") — and phase 3 can charge it without a data migration |
| `price_unit` | `'per_person' \| 'per_group'` | "$35 pp" vs "$45 per jeep" |
| `duration_text` | text ≤ 40 | "90 min", "3–4 hrs" — display only, no maths needs it |
| `open_weekdays` | `integer[]`, values 0–6 (0 = Sunday, JS `getDay()`) | **structured**, not prose, so phase 3 can offer only open days; "Closed Sundays" is derived |
| `start_times` | `text[]`, each `HH:MM` | the negotiated booking times; structured for the same reason |
| `lat`, `lng` | double, required | the matching pin (D6) |
| `radius_km` | double, 1–60, default 5 | per-experience reach (D6) |
| `photos` | `text[]`, 1–6 stems `slug/name` | D8 |
| `partner_contact` | text ≤ 200, nullable | ops needs it to schedule; **never** returned by a public endpoint |
| `active` | boolean, default true | O2 — switch off, never delete |
| `priority` | integer −100…100, default 0 | higher shows first; ties go to the nearest. Lets ops promote a partner without faking its distance |
| `created_by/updated_by/created_at/updated_at` | | same audit columns as `pricing_zones` (`schema.ts:909-921`) |

**Not stored (YAGNI until phase 3):** commission/net price, capacity per slot, cancellation policy.

### D5 — An interest stores what the customer saw
`experience_interests`: `id`, `experience_id` → experiences, `booking_id` → bookings (nullable),
`quote_id` → quotes (nullable, check: at least one set), `place_label` ("Sigiriya"), `source`
(`'booking_page' | 'quote_page'`), **snapshots** `name_snapshot`, `price_cents_snapshot`,
`price_unit_snapshot`, `status` (`'new' | 'contacted' | 'booked' | 'declined'`, default `new`),
`ops_note` (≤ 1000), audit columns. Unique `(experience_id, booking_id)` and
`(experience_id, quote_id)`.
**Why snapshots:** ops edits prices; the record must show what we told *this* customer.
**Why unique pairs:** a double tap or a retried request must not create two leads.
**Why this status set:** it is the smallest set that answers W1 ("which convert"); phase 3 adds `paid`.

### D6 — Matching is by map distance, per experience reach
An experience shows for a stop when the straight-line distance from the stop's point to the
experience's pin is **≤ its `radius_km`**. Results are sorted by `priority` (high first), then distance;
at most 6 per stop; an experience matched by an earlier stop is not repeated under a later one.
**Why distance, not place names:** the owner's examples — Dambulla, nearby towns, a safari park
~25 km away — don't share a name with the drop-off. **Why a per-experience radius, not one global
5 km:** a massage 3 km away and a safari 25 km away both belong to "Sigiriya"; one number can't
serve both. Default 5 km is the owner's figure.
**Prior art:** `pricing_zones` already stores a pin + `radius_km` and `hotZones.ts:73-84` has a
radius matcher — but pricing never runs it (`winningZoneForStops` passes no coords,
`hotZones.ts:110`), so this is the radius check's first live use. Distance uses the exported
`haversineKm` (`api/src/adapters/maps.ts:165`).

### D7 — One matcher, on the server
`GET /experiences/near?at=<label>@<lat>,<lng>` (repeatable) returns matches grouped per stop. The
booking page calls it; the quote-view builder calls the same function in-process.
**Why server-side, not ship the catalogue to the browser:** `booking.js` is a classic script and
can't import TypeScript, so a browser matcher would be a second copy that drifts from the quote
page's. One tested function serves both pages. Cost: one GET per step-3 render; the browser rounds
coordinates to 3 decimals (~100 m) before sending, and the response is `public, max-age=300`
like `GET /quote/pricing` (`api/src/routes/quote.ts:233-236`).

### D8 — Photos are files in the repo, not DB uploads
Photos live at `img/experiences/<slug>/<name>-900.jpg` + `-1800.jpg` (the guides convention,
resized with `sips -Z 900`, `docs/superpowers/plans/2026-09-28-destination-guides.md:130-157`).
The experience stores stems (`atherya-spa/massage`). Pages loads them from
`https://ceylonhop.com/img/experiences/…`.
**Why:** prod Supabase is on the **free plan** (owner, 2026-10-06): 500 MB database, and the
earlier backup review notes free projects have no backups. Photos would be the only large data
we store. Repo files cost nothing and load from GitHub Pages like the site's 300+ other images.
**Trade-off accepted:** a new photo is a small PR + `production` promote (Pages serves
`production`); ops can't upload. Revisit if prod moves to Supabase Pro.
**Absolute URLs everywhere:** the API host serves only an allow-list of root assets
(`api/src/routes/customerPages.ts:66-78`) — `img/experiences/…` would 404 on the quote and ops
hosts — and there is no CSP blocking cross-origin images (`api/src/app.ts:319-326`).
**Missing photo:** the card hides a broken `<img>` (onerror) rather than showing a broken icon.

### D9 — Where the stop points come from
| Page | Point used | Source |
|---|---|---|
| Booking, private single | exact drop-off picked in step 2 | `state.locToGeo` (`booking.js:292`, set by `setGeo` `:373`) — step 2 comes before step 3 |
| … else | the catalogue drop-off | `T.place(routeToId)` (`booking.js:207-209`, coords in `transfers-data.js:24-43`) |
| … else | a known name | `T.resolvePlace(name)` (`transfers-data.js:316`) |
| Booking, shared | catalogue drop-off | as above (no step-2 picker in shared, `booking.js:883`) |
| Booking, trip | each overnight stop by name | `T.resolvePlace` per `tripStops` (`booking.js:184`) |
| Quote page | each journey's destination + each stay | server: `knownCoords(name)` (`maps.ts:179`) then `place_resolutions` (`placeResolutionRepo.ts:27-34`) |
**Accepted limitation:** a trip stop that is a Google-picked place outside the catalogue gets no
point (plan.js passes names only, `plan.js:1638`), so no experiences for that stop. Fixing it
means carrying coordinates through plan → booking links — a separate change, not needed to launch.

### D10 — Booking page: the section and the write
- Step 3, after `#extras-block` (`booking.html:948-951`), in its own container — `#extras-block`
  is hidden for trips and shared rides (`booking.js:2371-2372`) and experiences must show for both.
- Heading "While you're in {place}" per matched stop; card per experience; Details & photos panel.
- Selected ids go in the booking payload as `experienceIds`, with `experiencePlaces` (id → the stop label it was shown under, so ops sees "Sigiriya") (all three modes), read off the raw body
  by a helper like `customerNotesFrom` (`api/src/routes/bookings.ts:470-484`).
  **Why the raw-body helper, not the Zod domain inputs:** `customerNotes` set this precedent, and it
  leaves `SingleTransferInput`/`TripInput` (stable interfaces, Hard rule 5) untouched.
- Unknown or inactive ids are dropped; max 10. Interests are written **after** the booking row,
  and a failure is logged, never thrown — the same shape as the concierge-task write
  (`bookings.ts:409-411`). **Why:** an interest must never cost us a booking.
- The idempotency key is built from the payload (`booking.js:3220-3226`), so a changed selection
  is a new key — correct, it is a different request.

### D11 — Quote page: the section and the write
- `GET /quote-view` adds `experiences: [{ place, items: [...] }]` to the view; `quote.html` renders
  it after the Day-by-day ticket (`quote.html:410-413`), before the closing note.
  **Why after the itinerary:** the quote's job is the price; experiences are the "while you're there".
- `POST /quote-view/interest` `{ t, experienceId, interested }`, token checked with
  `verifyQuoteViewToken` (`api/src/lib/bookingToken.ts:208`); only while the quote is live or
  lapsed; the experience must be one the view actually offered for that quote; rate-limited with
  the existing limiter (`api/src/app.ts:270`, `:388-399`).
- **This deliberately changes a past decision:** the quote page was built as a read-only proposal
  with "no POST" (`api/src/routes/quoteView.ts:12-13`; quote-page spec D6), because a forwarded
  link must be harmless. An interest moves no money and books nothing; the worst a forwarded
  link can do is create a lead ops then calls about. **Why not a WhatsApp link instead:** it leaves
  no record, so ops can't track it (O3/O4) and phase 2 can't exclude these customers.
- Un-tapping removes the interest only while it is still `new`; once ops has acted, it stays.
- **Quote → booking:** when a quote becomes a booking, its interests get `booking_id` set. There are
  three conversion paths and all three must call it: `POST /bookings/from-quote-v2`
  (`postgresQuoteConversionRepo.ts:42-91`), `POST /quotes/pay/start` (`quotePay.ts:327-345`) and
  ops "Mark booked" (`internalQuote.ts:1135-1159`). One repo method, `linkQuoteToBooking`, failure
  logged not thrown.

### D12 — Ops page "Experiences"
- New top-level page `#experiences`, routed and gated like `#rates` (`ops-ui.html:2298`, `:2449-2468`,
  `:4237-4245`), with two tabs: **Catalogue** (list + edit form) and **Interests** (the queue, O3).
- New capability `experiences:manage`, granted to **founder and ops** (`api/src/lib/opsAuth.ts:30-35`,
  "adding a capability is one row").
  **Why not reuse `rates:manage`/`quote:approve`:** those are founder-only money powers; the owner
  wants the ops team to maintain this, and the price here is display-only.
  **Why not finance:** not their job; they keep read access via the booking sheet.
- Location: ops pastes `lat, lng` or a Google Maps URL; the form parses both and shows an
  "Open in Google Maps" check link. **Why not a map picker:** the ops Maps loader exists only for
  the itinerary map (`ops-ui.html:11582-11588`); a paste is zero new Maps work and Google Maps'
  "copy coordinates" is one click for ops.
- No delete. **Why:** interests reference experiences; switching off (O2) keeps history and W1 counts.
- Interest status changes: `PATCH /admin/experience-interests/:id` under `bookings:operate`
  (founder + ops already hold it).

### D13 — Where ops sees interests
1. **Interests tab** (the queue): status new/contacted first, newest first, with customer name,
   booking/quote ref, travel date, place, experience, status dropdown, note.
2. **Booking detail sheet** (`renderSheet`, `ops-ui.html:3951`): an "Interested in" block.
3. **Team paid email** (`teamPaidEmail`, `opsNotifications.ts:342`): an "Interested in" row.
**Why no new "interest" email:** owner asked to "manage via ops"; a queue is checkable, an email
per tap is noise. The paid email already lands in ops's inbox for every real booking.

### D14 — Customer copy (owner-approved wording, 2026-10-06)
- Box above the cards: **"Nothing to pay now.** Tap "I'm interested" and our Ceylon Hop Pro team
  will reach out to help you schedule it. You pay the same price as booking direct — never more."
- Button: **"I'm interested"** → **"✓ Interested"**. (Owner rejected "Free · no charge" on the
  button as misleading.)
- After tapping, under the card: **"Noted — you won't be charged for this.** Our Ceylon Hop Pro team
  will message you with details and available times. You decide then."
- Booking summary: "You're interested in — not charged" + names.
- Confirmation email row: "Interested in: Ayurvedic massage (Atherya Spa) — not charged; our Pro
  team will reach out."
- Price line: "$35 pp · Same as booking direct".

### D15 — Never in the way
The booking page hides the section if `/experiences/near` fails or takes > 3 s; the quote view
returns `experiences: []` if matching throws; interest writes never fail a booking or a page.
**Why:** this is an upsell on the money path; it must not be able to break the money path.

### D16 — No feature flag
The section renders only when active experiences match. With zero active rows nothing shows, so
"turn it off" is "switch the experiences off" on the ops page.
**Why:** a flag is a config change (maintenance rule 3: stop-and-ask, plus a Render env edit on two
services); the data already gives us the switch.

### D17 — One analytics event
`experience_interest` (`{ experience_slug, place, source, interested }`) through each page's existing
`track()` helper. **Why:** the DB answers "who", GA4 answers "how many saw vs tapped" — W1 needs both.

## 4. Release & risk
- **Migration `0065`** (two new tables, no change to existing ones) auto-applies on staging at merge
  and on prod at the `main → production` promote (CLAUDE.md rule 7). Needs the owner's OK on the promote.
- Photos and booking/quote page changes go live on GitHub Pages only at the promote too
  (Pages serves `production`).
- Re-check the migration number at build time: parallel migration PRs must release in `when` order.
- No pricing, rate card, `config.ts` or generated-file changes.

## 5. Out of scope (phase 1)
Payment for experiences · slot choice · live availability · partner logins/notifications · commission ·
photo upload · showing on search/trip/guide/manage pages · the pre-travel email (phase 2).

## 6. Testing
- API unit: matcher (inside/outside radius, sort, cap, dedupe across stops), repos (in-memory + Postgres
  behind `DATABASE_URL_TEST`), routes (RBAC, CSRF, validation, public endpoint hides `partner_contact`),
  booking write (interests created, bad ids dropped, failure doesn't fail the booking), quote interest
  (token, liveness, offered-only, idempotent), conversion linking (all three paths), email rows.
- Migration test in the existing style (`paymentsBookingIdIndexMigration.test.ts`).
- e2e (offline, stubbed): booking step 3 shows/toggles/sends; quote page shows/taps; ops page CRUD;
  nothing shows when the endpoint fails.

## 7. Open items for the owner
1. Ops role gets `experiences:manage` (add/edit catalogue) — confirm, or founder-only?
2. Confirm the first real experiences + their pins, radius, times and photos (needed before launch, not before build).

## 8. Phase 3 (paid) — what phase 1 already does for it
- Money is integer cents + currency on the experience **and** snapshotted on each interest.
- Open days and start times are structured, so a slot picker reads them as-is.
- An interest is already its own row with a status; "paid" is one more status plus a payment link.
- Experiences live outside `rateCard.ts` and the engine, so charging for one becomes **its own line**
  on the booking (like a discount line in `pricing_snapshot_json`) without touching transfer prices.
- Still to design then: partner payout/commission fields, capacity per slot, cancellation/refund rules,
  whether it's paid at checkout or by a separate pay link.
