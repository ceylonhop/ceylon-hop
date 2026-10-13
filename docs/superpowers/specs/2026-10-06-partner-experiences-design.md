# Partner experiences near the drop-off — design

Date: 2026-10-06 · Status: draft for owner review (revision 2)
Grounding: every file:line below was checked against `origin/main` @ 06caf849 on 2026-10-06.
**Verified** = read in the code. **Unverified** = an assumption, with the check that settles it.

## 1. What this is

A new line of business. Ceylon Hop has negotiated deals with local businesses near where we drop
customers off (e.g. Atherya — Ayurvedic massage, Suwee — village cooking lesson, a Minneriya jeep
safari, all near Sigiriya). When a customer is going near a partner, we show the partner's
**experience** and let them tap **"I'm interested"**. Nothing is charged on the site.

**The end-to-end flow (owner, 2026-10-06):**
1. Customer taps "I'm interested" on the booking page or on their quote page.
2. The Ceylon Hop Pro team contacts them and confirms a time with the partner.
3. Ops sends a **separate PayHere payment link** (made in the PayHere portal) for the price the customer was shown.
4. Customer pays the link; ops records it as paid with the PayHere reference.

The website is **lead capture**; the money moves outside our system in phase 1.

### Phases

| Phase | What | Status |
|---|---|---|
| 1 | Catalogue in the DB + ops page; shown on the booking page and the quote page; interests worked by ops through to a PayHere link and "paid" | **This spec** |
| 2 | Pre-travel email to customers who picked nothing: top experiences + guides for their stops | Own spec, after phase 1 has live data (§8) |
| 3 | Ops generates the experience payment link **from the ops tool** instead of the PayHere portal, so the money lands in our records | Not built; §9 lists what phase 1 does for it |

**Why this order:** phase 2's audience is "who did *not* pick one" — a query on phase 1's table.
Phase 3 automates a step ops will by then have done by hand enough times to know its shape.

## 2. User stories

**Traveller**
- T1. Booking a transfer to Sigiriya, I see experiences near my drop-off.
- T2. I see price, duration, open days and times, details and photos.
- T3. I tap "I'm interested"; it is unmistakable that nothing is charged now.
- T4. I'm told the price is the same as booking direct, the Pro team will reach out, and if I go ahead I'll get a secure payment link.
- T5. On a quote link from ops, I see the same experiences for the places in my quote and can tap there too.
- T6. My booking confirmation email lists what I said I'm interested in.

**Ops**
- O1. Add and edit experiences without a developer (name, partner, area, price, days, times, details, photos, pin, reach).
- O2. Switch an experience off without deleting it.
- O3. One queue of open leads — only **real** ones: paid bookings and live quotes, never abandoned checkouts.
- O4. Move each lead new → contacted → link sent → paid / declined; record the PayHere reference and amount when paid; add a note.
- O5. See a booking's interests on its booking sheet.

**Owner**
- W1. Per experience: how many interested, how many paid, and how much was paid.

## 3. Decisions (each with its reason)

### D1 — The site never charges for experiences; the transfer total never changes
**Why:** owner call — "lightweight", ops sends a separate PayHere link. It also keeps checkout,
pricing and the PayHere webhook untouched, which is where this codebase carries its money risk.

### D2 — Called "experiences" in code and in the ops tool
**Why:** "add-ons"/"extras" already mean the sightseeing/waiting fees: `EXTRA_CODES`
(`api/src/quote/rateCard.ts:4`), `state.addons` (`booking.js:288`), `toggleAddon` (`booking.js:1339`).
Customers never see the word; they see "While you're in Sigiriya".

### D3 — Two new tables, not a reuse of an existing record
`experiences` (catalogue) and `experience_interests` (one row per customer × experience).
**Why not reuse:** `bookings.customer_notes` (`api/src/db/schema.ts:82`) is free text — no status
per experience, nothing phase 2 can query. `concierge_tasks` (`schema.ts:269-279`) has no link to
an experience or a quote, and nothing in the ops tool lists it. A JSON column on `bookings` can't
hold a quote-page interest, which exists before any booking (T5).

### D4 — What an experience stores
| Field | Type / rule | Why |
|---|---|---|
| `slug` | unique, `^[a-z0-9-]{3,60}$` | stable id; names the photo folder |
| `name`, `partner_name` | ≤ 80 | the card's title and byline |
| `area_label` | ≤ 40, e.g. "Sigiriya" | the place ops and the customer associate it with; **set by ops**, so nothing a browser sends ends up as a label in the ops tool (D11) |
| `summary` | ≤ 160 | the card's one-liner |
| `details` | ≤ 2000, plain text | "package details" in the Details panel |
| `price_cents` + `currency` (`'USD'`) | integer + text | project money rule (CLAUDE.md "Stack"); the price ops puts on the PayHere link |
| `price_unit` | `per_person` \| `per_group` | "$35 pp" vs "$45 per jeep" |
| `duration_text` | ≤ 40, optional | "90 min", "3–4 hrs" — display only |
| `open_weekdays` | `integer[]`, 0–6 (0 = Sunday, JS `getDay()`) | structured so phase 3 can offer only open days; "Closed Sun" is derived |
| `start_times` | `text[]` of `HH:MM` | the negotiated booking times, structured for the same reason |
| `lat`, `lng` | required, inside Sri Lanka (lat 5.8–10.0, lng 79.4–82.0) | the matching pin (D6); the box catches a swapped "lng, lat" paste |
| `radius_km` | 0 < r ≤ 60, default 5 | per-experience reach (D6) |
| `photos` | `text[]`, ≤ 6 paths under `img/` without the size suffix (`experiences/atherya-massage/treatment`, or an existing live photo such as `guides/sigiriya/ayurveda`) | D8 |
| `partner_contact` | ≤ 200, optional | ops needs it to schedule; **never** sent to a customer page |
| `active` | default true | O2 — switch off, never delete |
| audit | `created_by`, `updated_by`, `created_at`, `updated_at` | same as `pricing_zones` (`schema.ts:909-921`) |

**Cut (YAGNI):** a `priority`/sort field — with a handful of partners per area, nearest-first is
enough; add it when an area has more experiences than fit. Commission, capacity and cancellation
fields — phase 3.

### D5 — What an interest stores
`id`, `experience_id`, `booking_id` (nullable), `quote_id` (nullable; check: at least one set),
`source` (`booking_page` | `quote_page`), snapshots `name_snapshot`, `price_cents_snapshot`,
`price_unit_snapshot`, `status` (`new` | `contacted` | `link_sent` | `paid` | `declined`, default `new`),
`payment_ref` (≤ 100), `amount_paid_cents` (≥ 0), `amount_paid_currency` (`USD` | `LKR`),
`ops_note` (≤ 1000), audit columns. Unique `(experience_id, booking_id)` and `(experience_id, quote_id)`.
- **Snapshots:** ops edits prices; the link must be for the price *this* customer was shown — that is
  what keeps "same price as booking direct" true per customer.
- **`link_sent` and `paid`:** ops sends PayHere links (owner, 2026-10-06), so "has a link but hasn't
  paid" is the follow-up list ops needs; `paid` + amount is what W1 counts.
- **Payment fields:** these payments never touch our system (D13), so the reference and amount are
  the only record we will have. `LKR` is allowed because local partners may price in rupees and a
  PayHere link can be in LKR (PayHere's supported currencies — general knowledge, not checked in code);
  the experience's display price stays USD like every other price on the site.
- **`paid` requires `payment_ref`:** a "paid" with no reference can't be reconciled against PayHere.
- **Unique pairs:** a double tap or a retried request must not create two leads.

### D6 — Matching is by map distance, each experience with its own reach
An experience shows for a stop when the straight-line distance from the stop's point to the
experience's pin is ≤ its `radius_km`. Nearest first; at most 6 per stop; an experience shown
under an earlier stop is not repeated under a later one.
**Why distance, not names:** the owner's examples — Dambulla, nearby towns, a safari park — don't
share a name with the drop-off. **Why a reach per experience:** a spa 3 km away and a safari ~25 km
away (rough estimate) both belong to "Sigiriya"; one global 5 km would drop the safari. Default 5 km
is the owner's figure. Distance: `haversineKm` (`api/src/adapters/maps.ts:165`, exported).
**Prior art, honestly:** `pricing_zones` stores a pin + `radius_km`, and `hotZones.ts` has a radius
check (`api/src/quote/hotZones.ts:73-84`), but pricing never runs it — `winningZoneForStops` passes
no coordinates (`hotZones.ts:110`). This is the first live use of radius matching.

### D7 — One matcher, on the server
`GET /experiences/near?at=<label>@<lat>,<lng>` (repeatable) returns matches grouped per stop; the
booking page calls it, the quote view calls the same function in-process.
**Why:** `booking.js` is a classic script and can't import TypeScript; a browser copy of the matcher
would drift from the quote page's. Cost: one GET when step 3 renders with a new stop set. The browser
rounds coordinates to 3 decimals (~100 m) before sending. Response cached `public, max-age=300` (the
same header pattern as `GET /quote/pricing`, `api/src/routes/quote.ts:233-236`, which uses 60 s) — **so an experience ops switches off can
keep showing for up to 5 minutes.** Accepted.

### D8 — Photos are files in the repo, not uploads
`img/experiences/<slug>/<name>-900.jpg` + `-1800.jpg`, the guides convention (resize with
`sips -Z 900`, `docs/superpowers/plans/2026-09-28-destination-guides.md:130-157`). Experiences store
paths under `img/` without the size suffix (`experiences/atherya-massage/treatment`); pages load
`https://ceylonhop.com/img/<path>-900.jpg`. **Why a path under `img/`, not just a name:** placeholders and
tests can point at photos that are already live (the Sigiriya guide's own photos), so testing needs no
photo PR or promote; real partner photos still go in `img/experiences/`.
**Why:** prod Supabase is on the **free plan** (owner, 2026-10-06) — a 500 MB database (Supabase's
published limit; not checked against the account) — and photos would be the only bulky data we'd store.
**Absolute URLs:** the API host serves only an allow-list of root assets
(`api/src/routes/customerPages.ts:66-78`), so `img/experiences/…` would 404 on the quote host and in
the ops tool; and there is no CSP blocking cross-origin images (`api/src/app.ts:319-326`, "No CSP here").
**Cost accepted:** a new photo is a small PR **and a `production` promote** — Pages serves
`production`, not `main` — so a photo can't be seen anywhere (staging and the ops preview included)
until it's promoted. Photos therefore ship in their own PR **before** ops enters the experience.
A missing photo hides itself (`onerror`) instead of showing a broken image.

### D9 — Where each page's stop points come from
| Page / mode | Point | Source |
|---|---|---|
| Booking, private single | the exact drop-off picked in step 2 | `state.locToGeo` `{name,address,lat,lng}` (`booking.js:292-293`), set by `setGeo` (`booking.js:373`); step 2 comes before step 3 |
| … not picked | the catalogue drop-off | `T.place(routeToId)` (`booking.js:207-209`; coords in `transfers-data.js:24-43`) |
| … not in catalogue | a known name | `T.resolvePlace(name)` (`transfers-data.js:316`) |
| Booking, shared | catalogue drop-off | as above (no step-2 picker in shared mode) |
| Booking, trip | each overnight stop, by name | `T.resolvePlace` over `tripStops` (`booking.js:184`) |
| Quote page | each driving leg's `to` (stay legs and the first origin skipped); legs read with `requestLegs()` (`api/src/db/quoteRouteText.ts:14-27`), which falls back to the top-level `legs` older rows use | server: `knownCoords(name)` (`maps.ts:179`), else `place_resolutions` by canonical key (`api/src/db/placeResolutionRepo.ts:27-34`) |

**Accepted limitation:** a trip stop picked from Google outside the catalogue has no point (plan.js
passes stop names only, `plan.js:1638`), so that stop shows no experiences.
**Unverified — quote coverage:** quote stops are free text and often hotel names, which neither
lookup may know. Before building the quote page (PR 6), measure coverage on recent quotes (plan, PR 6 gate).
If coverage is poor, the fix is to store coordinates on the quote when ops picks a place — not
to pay for Google lookups on every quote view (September's Maps bill was mostly our own CI).

**Headings:** "While you're in {stop}", using the part before " / " ("Sigiriya / Dambulla" → "Sigiriya").
**Distance on the card:** road-adjusted, "about X km away" = straight-line × 1.35, the same factor the
codebase's own fallback distance uses (`maps.ts:210`). Straight-line understates road distance.

### D10 — Booking page
- Step 3, in a new `#experiences-block` after `#extras-block` (`booking.html:948-951`). Its own block
  because `#extras-block` shows only for single private transfers (`booking.js:2371-2372`) and
  experiences must show for trips and shared rides too.
- Selected ids go in the booking payload as `experienceIds` (all three modes), read off the raw body
  like `customerNotes` (`customerNotesFrom`, `api/src/routes/bookings.ts:470-484`). **Why not Zod domain
  inputs:** `customerNotes` set this precedent, and it leaves `SingleTransferInput`/`TripInput`
  (stable interfaces, Hard rule 5) untouched. Only ids — no labels — come from the browser (D11).
- A malformed list is ignored, never a 400 (a stale cached page must not lose a booking). Unknown
  or inactive ids are dropped; at most 10.
- Interests are written right after the booking row, best-effort, the same shape as the concierge
  write (`flagForOps`, `bookings.ts:402-411`): a failure is logged, never returned.
- **Bookings are created as `draft`, before payment** (`api/src/db/postgresBookingRepo.ts:461`), so an
  interest exists for every checkout that is abandoned. That is fine to store and wrong to work: the
  ops queue shows a booking's interests only once the booking is `paid`, `confirmed`, `in_progress` or
  `completed` (the post-payment states, `api/src/domain/status.ts:2-29`), and drops them if it's
  `cancelled`, `refunded` or `no_show`.

### D11 — Nothing a browser sends becomes ops-tool text
The interest's place comes from the experience's `area_label` (ops-set), and the name/price from the
server's snapshot. The only browser input is a list of uuids. **Why:** `ops-ui.html` builds pages
from HTML strings; a customer-controlled label stored and shown there is a script-injection path
into an internal tool. Ops-ui still escapes what it renders, as defence in depth — but note it has **two**
helpers: the dashboard script's `esc` (`ops-ui.html:2208`, escapes `& < > "` but **not** `'`, so attributes
must be double-quoted; the booking sheet lives here) and the QuoteView module's `esc` (`ops-ui.html:4806`,
where the Rates page — and so the Experiences page — renders).

### D12 — Quote page
- `GET /quote-view` adds `experiences: [{ place, items }]` (each item flagged `interested`);
  `quote.html` renders it after the Day-by-day ticket (`quote.html:410-413`), before the closing note.
  **Why after the itinerary:** the quote's job is the trip and its price.
- `POST /quote-view/interest` `{ t, experienceId, interested }`: token checked by
  `verifyQuoteViewToken` (`api/src/lib/bookingToken.ts:208`); the quote must be `ready` or `sent`
  (the liveness `quoteView.ts:169-191` already computes); the experience must be one the view offers
  for that quote; rate-limited with the existing limiter (`app.ts:270`, mounted per path at `:388-399`).
- A **lapsed** quote (status still `ready`/`sent`, `offerValidUntil` passed, `quoteView.ts:191-193`) still
  shows experiences and accepts taps, and its leads stay in the queue. **Why:** ops refreshes lapsed
  quotes on request, and the customer's interest is just as real. Deleted quotes (`deleted_at`,
  `schema.ts:792`) never appear.
- **This reverses a past decision on purpose.** The quote page was built read-only — "no POST"
  (`api/src/routes/quoteView.ts:12-13`) — so a forwarded link is harmless. An interest moves no money;
  the worst a forwarded link can do is create a lead ops then contacts. **Why not a WhatsApp link
  instead:** no record, so no queue (O3/O4), no W1 counts, and phase 2 couldn't exclude these customers.
- Un-tapping removes the interest only while it's `new`; once ops has acted, it stays.
- **Quote → booking:** the quote's interests get `booking_id` set at all three conversion points:
  `POST /bookings/from-quote-v2` (`api/src/routes/quoteConversion.ts:33`), `POST /quotes/pay/start`
  (`api/src/routes/quotePay.ts:327-345`) and ops "Mark booked" (`api/src/routes/internalQuote.ts:1135-1159`).
  One repo method; a failure is logged, never fails the conversion.

### D13 — Payments happen outside our system (phase 1)
Experience money goes customer → PayHere portal link → our PayHere account. Consequences:
- Our ops payment lookup, ops analytics totals, server-side GA4 `purchase`, and the "Paid:" team email
  will **not** include experience money. Reconciliation is PayHere portal + the `payment_ref`/amount
  fields on each interest.
- Refunds for experiences are done by hand in the PayHere portal. **The site's terms cover transfers,
  not experiences** — the owner's rule (§7.3): free cancellation up to 24 hours before the experience date.
- **Unverified — webhook noise:** if PayHere notifies our notify URL for portal-link payments, our
  webhook answers `unknown_order` (404) without an alert (`api/src/routes/webhooks.ts:253`) but logs a
  refused checkout event — noise in "no payments?" triage. Check: pay one small test link, then look for
  an `unknown_order` row in `booking_checkout_event` (a prod read; needs the owner's OK).

### D14 — Ops page "Experiences"
- New top-level page `#experiences`, routed and gated like `#rates` (`routeStateFromUrl`
  `ops-ui.html:2298`, `setNav` `:2449-2468`, dispatcher `:4237-4245`). Tabs: **Catalogue** and **Leads**.
- New capability `experiences:manage` for founder **and ops** (matrix `api/src/lib/opsAuth.ts:30-35`,
  "adding a capability is one row"). **Why not `rates:manage`/`quote:approve`:** those are founder-only
  money powers; the price here is display-only and the owner wants ops to maintain it (decided, §7.1).
- Location: ops pastes `lat, lng` or a Google Maps URL; the form parses it and shows an "Open in Google
  Maps" check link. **Why not a map picker:** the ops Maps loader serves only the itinerary map
  (`ops-ui.html:11582-11588`); a paste needs no new Maps work.
- No delete — interests reference experiences, and W1 needs the history.
- Lead status changes under `bookings:operate` (founder + ops already hold it, `opsAuth.ts:30-35`).

### D15 — Where ops sees leads
1. **Leads tab** — one joined query: open leads (new / contacted / link sent), filtered per D10, newest
   first, with customer name, contact, booking/quote ref, travel date, area, experience, quoted price,
   status, payment ref/amount, note. **Why one query:** the ops bookings list was N+1 until #703; a
   per-row lookup here would repeat it on a free-plan database.
2. **Booking sheet** (`renderSheet`, `ops-ui.html:3951`, fed by `GET /admin/ops/bookings/:id` — `ops.ts:294`,
   router mounted at `app.ts:590`): an "Interested in" block. Its guard is `bookings:read`, which finance also
   holds, so the status control shows only when the viewer has `bookings:operate`.
3. **Team paid email** (`teamPaidEmail`, `api/src/services/opsNotifications.ts:342`): an "Interested in" row,
   added in that email's own facts — **not** in the shared `factRows` (`notifications.ts:214-261`), which about
   a dozen customer and ops templates reuse.
**Why no email per tap:** the owner asked to "manage via ops"; the paid email already reaches ops for every real booking.

### D16 — Customer copy (owner-approved 2026-10-06; button wording revised by the owner)
- Box above the cards: **"Nothing to pay now.** Tap "I'm interested" and our Ceylon Hop Pro team will
  reach out to help you schedule it. You pay the same price as booking direct — never more."
- Button: **"I'm interested"** → **"✓ Interested"**. (The owner rejected "Free · no charge" on the button.)
- Under the card after a tap: **"Noted — you won't be charged for this.** Our Ceylon Hop Pro team will
  message you with details and available times. If you go ahead, we'll send you a secure payment link."
- Price line: "$35 pp · Same as booking direct". Distance: "about 4 km away".
- Booking summary: "You're interested in — not charged" + names.
- Confirmation email row: "Interested in: Ayurvedic massage (Atherya Spa) — not charged; our Pro team will reach out."
- **"never more" is a standing promise:** it stays true only if ops keeps each price equal to the
  partner's direct price — the team owns this (decided, §7.4).

### D17 — Never in the way
The booking page hides the section if `/experiences/near` fails or takes longer than 3 s; the quote view
returns `experiences: []` if matching throws; interest writes never fail a booking, a quote page or a
conversion. **Why:** this is an upsell sitting on the money path.

### D18 — No feature flag
Nothing shows unless an active experience matches, so "off" = switch the experiences off in ops.
**Why:** a flag is a config change (maintenance rule 3) on two Render services; the data is already a switch.

### D19 — Measuring it
- **Primary, from our own data:** website bookings created vs paid, 14 days before vs 14 days after the
  first experience goes live; interests per paid booking; leads reaching `paid`. Honest caveat: at a few
  bookings a day this is a sanity check, not a statistically firm test.
- **Stop rule:** if paid conversion clearly drops after launch, collapse the section to one line
  ("Things to do near Sigiriya (3)") that expands on tap.
- **Secondary, GA4:** `experience_interest` via `window.chTrack` (`booking.js:442` shows the call pattern;
  `quote.html:103-105` wraps it). **Unverified:** whether a new custom event reaches GA4 depends on a GTM
  tag forwarding it; the funnel events once never reached GA4 for this reason. Check in GTM before relying on it.

### D20 — Staging test data: Sigiriya placeholders only (owner, 2026-10-06)
The owner will test on staging (site + ops) with **placeholder Sigiriya experiences only**, and they
must not show for any other location.
- Three placeholders, modelled on the approved mockup: Ayurvedic massage (Atherya Spa), village cooking
  lesson (Suwee), elephant jeep safari. Slugs start `placeholder-` so they're easy to find and switch off.
  Photos reuse the Sigiriya guide's live photos (`guides/sigiriya/ayurveda`, `…/family-food`,
  `…/village`, `…/elephants` — all present in `img/guides/sigiriya/`), so no photo PR is needed to test.
- **Why they can't show elsewhere:** every pin is within ~8 km of the catalogue Sigiriya point
  (7.95, 80.76; `transfers-data.js:36`) with a reach of at most 10 km, so nothing beyond ~18 km of Sigiriya can
  match. The nearest other catalogue place is Anuradhapura at ~56 km (computed from `transfers-data.js`
  PLACES on 2026-10-06). A test enforces this against every catalogue place (plan Task 2.4). A hotel picked
  from Google within ~10 km of a pin (e.g. in Sigiriya village) will see them — that is the Sigiriya area.
- **Where they go:** the **staging** database only — staging's DB is a separate Supabase project from prod
  (confirmed 2026-10-04). Seeded by pasting `api/scripts/experience-placeholders.sql` into the staging
  project's Supabase SQL Editor, the same way `api/scripts/clear-test-data.sql` is run. Idempotent (re-runnable).
- **Why SQL, not a migration:** migrations run on prod too; placeholder data must never reach prod.
- Staging builds from `main` (Cloudflare Pages `ceylon-hop-staging`, branch `main`) and the staging API
  auto-deploys from `main`, so each PR is testable on staging as soon as it merges, before any promote.
- Before real launch: switch the placeholders off on staging (or leave them — staging only); prod gets real
  experiences entered by ops (launch checklist).

### D21 — Experience confirmation email, with when and where (owner, 2026-10-07)
When ops has taken payment for an experience, the customer gets a confirmation email from us.
- **Migration 0067** adds to `experience_interests`: `scheduled_date` (date), `scheduled_time` (text `HH:MM`,
  Sri Lanka local time; CHECK `^([01][0-9]|2[0-3]):[0-5][0-9]$`), `meeting_point` (≤ 200), `confirmation_sent_at`
  (timestamptz), `confirmation_channel` (text, CHECK `in ('email','whatsapp')`). All nullable, no defaults — nothing
  existing is rewritten. (Numbered 0067 because 0066 is
  `deposit_payments`, PR #940, which releases first; this migration's `when` is later than 0066's so drizzle
  never skips it. If this merges before #940, re-stamp 0067's `when` or 0066 is skipped.)
  **Why date + local time, not a timestamptz:** the experience happens in Sri Lanka at a wall-clock time the
  partner gave us; storing it as an instant invites a timezone shift between ops, the email and the customer.
- **Ops (Leads tab, and the booking sheet's Interested-in block):** when a lead is **Paid**, ops fills date, time
  and meeting point and presses **Send confirmation**. After sending: "Confirmation sent ✓ {d MMM HH:mm}" and a
  **Resend** button. `POST /admin/experiences/leads/:id/confirmation` (csrf + `bookings:operate`) refuses unless
  the lead is `paid` (409 `not_paid`), has a date and time (400 `schedule_required`), and the customer has an
  email address (422 `no_email`); a send that fails is 502 `send_failed` and leaves `confirmation_sent_at` as it
  was. The booking sheet shows the schedule and "Confirmation sent ✓" read-only.
- **A paid lead stays on the Leads tab until its confirmation has been sent** (implementation note): D15 had a
  lead leave the list once paid, but a paid lead still has a date, a time and an email to do, and ops usually has
  the date from the partner later than the payment. Once the confirmation is sent it leaves on the next load
  (the row stays on screen for the session, so Resend works straight after sending).
- **Confirmed on WhatsApp (review fix, PR #950):** a quote-only lead often has only a phone number, so the email
  can never be sent and, with the rule above alone, the lead could never leave the list except by being falsely
  marked declined. `POST …/confirmation` therefore also accepts `{ "channel": "whatsapp" }` (strict body; omitted =
  email): it needs `paid` (409 `not_paid`), does **not** need a date or time, **sends nothing**, and stamps
  `confirmation_sent_at` + `confirmation_channel = 'whatsapp'` (a successful email stamps `'email'`). The ops UI
  shows **Mark confirmed on WhatsApp** beside Send confirmation when the email path answered `no_email`, or for a
  quote lead whose contact is not an email address; afterwards the row and the booking sheet read "Confirmed on
  WhatsApp ✓ {d MMM HH:mm}". Send/Resend is disabled and re-clicks ignored while a confirmation POST is in flight.
- **Date safety net:** `listLeads` also drops a paid, unconfirmed lead once its `scheduled_date` is before today in
  Sri Lanka (`(now() AT TIME ZONE 'Asia/Colombo')::date`; the in-memory repo uses the same zone). A paid lead with
  no date yet stays. **Why:** a lead nobody confirmed must not sit on the list forever once the experience is past.
- **Recipient:** the booking's customer email. A quote-only lead uses `quotes.customer_contact` only when it is an
  email address; otherwise the button says "No email on file — confirm on WhatsApp" and sends nothing.
- **Email** (existing email adapter + brand template, `emailBrand.test.ts` rules): subject
  "Confirmed: {experience} on {Sat 21 Nov}". Body: experience and partner, date and time, meeting point (if any),
  amount paid and PayHere reference (if recorded), "Free cancellation up to 24 hours before the experience date.",
  WhatsApp contact, and the booking/quote reference. Text and HTML versions; a dev preview at
  `/dev/emails/experience-confirmed`. Not recorded in the customer-communication ledger (it is keyed on a booking
  and a quote-only lead has none).
- **Sent only when ops presses the button** — never automatically on status change. **Why:** the date and time
  come from a WhatsApp conversation with the partner; ops is the one who knows they're final.

## 4. Release & risk
- **Migration 0065** (two new tables; nothing existing altered) auto-applies on staging at merge and on
  prod at the `main → production` promote (CLAUDE.md rule 7) — needs the owner's OK on that promote.
  Re-check the number at build time: the latest on `main` @ 06caf849 is 0064, and parallel migration PRs
  must release in `when` order.
- Booking/quote page changes and photos go live on Pages only at the promote.
- No change to pricing, `rateCard.ts`, `departureRepo.ts`, `config.ts`, env, or generated files.

## 5. Out of scope (phase 1)
Charging on the site · slot choice · live availability · partner logins/notifications · commission ·
photo upload · showing on search/trip/guide/manage pages · the phase-2 email.

## 6. Testing
- API: matcher; input schema; repos (in-memory + Postgres behind `DATABASE_URL_TEST`); ops routes (RBAC,
  CSRF, validation, `paid` needs a ref); public endpoint never returns `partner_contact` or the pin; booking
  write (ids only, bad ids dropped, failure doesn't fail the booking, replay doesn't duplicate); the queue
  hides drafts and cancellations; quote interest (token, liveness, offered-only, idempotent, withdraw
  rules); linking at all three conversion points; email rows.
- Migration test in the existing style (`api/src/db/paymentsBookingIdIndexMigration.test.ts`).
- e2e (offline, stubbed — the ops pattern is `web-tests/e2e/ops-rates-page.spec.js:54-59`): booking step 3
  shows/toggles/sends and **the total never changes**; nothing shows when the endpoint fails; quote page
  shows/taps/reverts on failure; ops catalogue CRUD; leads tab status flow.

## 7. Owner decisions (2026-10-06)
1. **Ops edits experiences** — `experiences:manage` goes to founder **and** ops (D14).
2. **Full phase 1** — the quote page is in scope. Its coverage gate (plan, PR 6) still runs first, but a
   poor result now means "store coordinates on quotes first", not "drop the quote page".
3. **Refund rule for experiences: free cancellation up to 24 hours before the experience date.** Ops states
   it in the PayHere payment message. Refunds are made by hand in the PayHere portal (D13).
4. **The team keeps partner prices equal to their direct prices**, which keeps "never more" true (D16).
5. **Deferred:** the PayHere portal-link test and the one prod read that checks for webhook noise (D13).
   Do it before the first real payment link goes out (launch checklist L2).
6. Still needed before launch, not before building: the first real experiences — pin, reach, times, photos.

## 8. Phase 2 notes (for its own spec)
- Audience: paid bookings with no interest, N days before the first travel date (`booking_legs.travel_date`).
- **It is a marketing email.** `customers.marketing_opt_in` already exists (customers table in
  `api/src/db/schema.ts`) — phase 2 must respect it and carry an unsubscribe link; UK/EU visitors are
  already treated differently by the site's consent code.
- Quote-only customers have a free-text contact only (`quotes.customer_contact`), so phase 2 targets bookings.

## 9. Phase 3 notes (paid via our own link)
- Money is already cents + currency on the experience and snapshotted on each interest.
- Open days and start times are structured, so a slot picker reads them as-is.
- `link_sent`/`paid` + `payment_ref`/amount already model the lifecycle; phase 3 fills them automatically.
- The codebase already has its own pay-link system (`pay.html`, the `/p` short path, `customerPages.ts:224`);
  generating the experience link there would put the money in our records, analytics and emails.
- Still to design then: partner payout/commission, capacity per slot, cancellation rules.
