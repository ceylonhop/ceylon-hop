# The Ride Board — community demand-pooling for shared rides

**Status:** design spec — approved direction, build NOT started (deferred until after go-live + payments work; needs a fresh explicit go from the owner).
**Date:** 2026-07-23
**Prototype:** [`docs/prototypes/ride-board-prototype.html`](../../prototypes/ride-board-prototype.html) — fully interactive static prototype (no API), open directly in a browser.

---

## 1. Why

Shared taxi was Ceylon Hop's founding idea: preset corridors, preset Wed/Sat schedule, buy a seat. It never filled — we carried the empty-seat risk and guessed the timetable. Meanwhile the trusted website turned the business into private transfers and chauffeur trips.

The Ride Board flips shared rides from **supply-first to demand-first**: travellers post the ride they want ("a list"), recruit co-riders via shareable links, and Ceylon Hop sends a van only once enough names commit. We are asset-light here — a "confirmed" list is operationally just a private transfer with a split fare, a product we already run. A failed list costs us nothing and still yields demand data.

### Prior art (researched 2026-07-23)

| Who | Model | Lesson for us |
|---|---|---|
| **Beeline (Singapore, GovTech)** | Commuters suggest routes; routes auto-activate on demand | The demand data was as valuable as the rides. Feed every list (filled or not) into founder Analytics. |
| **Rally (rally.co, alive)** | Event-anchored crowdsourced buses; trip confirms at a rider threshold | Threshold mechanic works commercially when demand is anchored. Our anchor = the tourist trail (Ella↔Kandy etc. on specific dates). |
| **Chariot / Bridj (dead)** | Crowdsourced commuter shuttles, owned fleets | Demand fragmentation + fixed costs killed them. We constrain choices (corridor stops only) and own no incremental fleet. |
| **GAFFL** | Travel-buddy matching, cost splitting | Travellers want this; weak vetting is the #1 complaint. Google sign-in + "real names only" is our trust wedge. |
| **Facebook groups / WhatsApp** | The incumbent: "anyone sharing a taxi Ella→airport Tuesday?" | Don't compete — **integrate**. The share link is designed to be dropped INTO those groups. |
| **12Go (Stef Lanka Shuttle etc.)** | Fixed scheduled shared vans on tourist corridors | Corridor competition exists; our differentiators are any-date demand pooling + door-to-door + $0-unless-it-runs. |

## 2. The mechanic ("a list")

- A **list** = corridor-constrained route (from/to are stops on one existing corridor), a date (any day — this kills the Wed/Sat constraint), a coarse departure slot, an optional note from the starter.
- **Threshold:** list "runs" at `minSeats` names (default 4; per-corridor value from the rate card — 4×$14 and 4×$24 are different van economics; see Open issues).
- **Deadline:** list closes at `cutoffAt` (default 48h before departure, Asia/Colombo).
- **Lifecycle:** `gathering → confirmed | expired`. Confirmed lists keep accepting names up to van capacity.
- **Money:** joining = card **preapproval hold, $0 charged** (PayHere Preapproval API). At threshold+cutoff, everyone is charged their seat price via the PayHere Charging API. List didn't fill → nobody pays.
- **Fallback ladder (no list ends in silence):** at cutoff, an unfilled list's members are offered (a) upgrade to private at the fare split among current members, (b) move to the next scheduled shared departure, (c) walk away — hold released.
- **Scratch-off:** free self-removal anytime before cutoff (releases the hold). See Open issues for the regression-notification problem.
- **Identity:** customer Google sign-in (first customer-facing auth). Public display is **first name + country flag + avatar** only — never email/phone.

### Copy voice (load-bearing)

Helpful hostel-noticeboard, never salesy: "put your name on the list", "4 names = we send a van", "$0 unless the ride actually runs", "your name here?", "scratch off anytime". Price framed socially ("≈ $24 each when it runs · $0 if not"), no strikethrough anchor pricing on the board.

## 3. UX / information architecture

Three surfaces, one page + one detail + one modal flow. **The board IS the landing page** — no explainer standing between the visitor and the wall of people.

### 3.1 Board (landing)

- Compact header (title + one-line explanation + single red hand-note "$0 unless the ride actually runs"), corridor filter chips, then immediately the grid of list cards.
- **List card** (site ticket style, perforation divider): route in Newsreader serif, date/slot + "closes …" meta, status pill (`Needs 2 more names` saffron / `One name from running` tomato+pulse / `Van locked in — N seats still open` teal), 4 progress dots ("RUNS AT 4"), then **exactly 4 numbered sign-up lines** — avatars + first names + flags, "started this list" on line 1, next open line rendered as dashed *"your name here?"*. Riders past 4 collapse to a "+N also riding" stacked-avatar row (equal card heights; grid uses stretch). Footer: quiet price + **"See ride & join →"** button. Starter's note quoted at the bottom. Confirmed cards wear the brand postage stamp "IT'S ON! van locked".
- **Predictability rule (owner-set):** labels must match destinations. Card body & "See ride & join →" navigate to the ride page. The *"your name here?"* line is the one action shortcut: it opens the ride page **with the join flow auto-opened on top** — the label's promise is kept in one click, trust page visible behind.
- Last card: dashed **"Your ride's not up here?"** → create flow.

### 3.2 Ride detail page (the trust builder AND the share-link destination)

Every list has a real page (`/board/<id>`; prototype uses `#/<id>`), because a WhatsApp/Facebook share must land somewhere link-able with OG tags ("Ella → Mirissa · Sat · 2 of 4 in · $24/seat"). Content order:

1. Route + meta (duration door-to-door, van, capacity).
2. **Who's in so far** — large avatars/names/countries + dashed "you?" / "a friend?" join slots; starter's note.
3. **How the money works** — 3-step timeline: *Today $0 hold → deadline: 4 names = everyone charged, else nobody pays → departure day, driver name & WhatsApp the evening before.* This is the trust engine.
4. **The route** — pickup/drop rail (door-to-door, ~10 km pickup radius per stop, reuses exact-spot radius rule).
5. **Who's driving** — real operator, Tripadvisor 5.0, humans on WhatsApp, Google-verified travellers.
6. Mini-FAQ (cancel policy, pickup logistics, luggage).
7. **Sticky join card** (right rail): price, "$0 today" promise, avatar row with empty slots, deadline, CTA "Add my name — $0 today", share buttons ("Know someone heading that way?").

### 3.3 Join flow (modal over the detail page, 3 steps)

1. **Google sign-in** — "lists only take real names"; privacy whisper: others see "Roshen 🇱🇰", nothing more.
2. **The deal + card** — "$0 today" info box (deadline + charge condition restated), PayHere preapproval (see Open issues for the real handoff UX), Visa/MC note.
3. **Success** — the member's name handwrites onto their line (Caveat, the site's one hand-font moment), headline states the new count, then the **share moment**: preview card of what the link unfurls to + WhatsApp / Facebook / copy-link. "We'll email you the second someone signs under you."

### 3.4 Create flow (4 steps; same staircase + a plan step)

1. **Plan the ride** — From/To **dropdowns constrained to corridor stops** (no free-form autocomplete; anti-fragmentation by construction), any-date picker, Morning/Afternoon chips, optional note to future vanmates, quiet price strip, CTA "Put it on the board" ("it goes up instantly — you're name #1 of 4").
2–3. Same Google + $0-hold steps.
4. **"Your list is up on the board."** — name on line 1, share moment is the payoff (the starter is the recruiter), plus "See your list on the board" → their ride page. New list appears at the front of the board immediately.

### 3.5 Living-board signals

Real activity only in production (see Open issues — no fake liveliness): join toasts, count in the filter bar ("5 lists gathering names"), email on every name-under-you and on confirm/expire.

## 4. Visual design

Strictly the existing site system (`site.css` tokens): Newsreader display, Hanken Grotesk body, Caveat **only as garnish** (one hand-note in the header, "your name here?" lines, success-moment name); cream/postcard washes, paper cards, ticket perforation, postage stamp for confirmed; teal for join CTAs (tomato reserved for the site's conversion moments). Explicitly rejected during design: literal corkboard/pin/tape/polaroid skeuomorphism — costume, not brand.

## 5. Backend sketch (all additive; reuses existing machinery)

Existing parts that carry this feature: corridor catalogue + atomic seat holds (`departureRepo`), HMAC token links (`bookingToken` pattern), templated email + scheduler sweeps (`notifications.ts` / `scheduler.ts`), ops GIS sign-in pattern (`opsAuth`), Zod domain modules, repo-interface + InMemory/Postgres pairs.

New (sketch, not final):

- `ride_list` table: id (short public code), corridorId, fromStop, toStop, date, slot, minSeats, cutoffAt, status (`gathering|confirmed|expired|cancelled`), note, createdBy, timestamps.
- `ride_list_member`: listId, position, googleSub, firstName, countryCode, email, preapprovalTokenRef (encrypted), status (`held|charged|charge_failed|scratched`), joinedAt.
- Customer auth: GIS → HMAC session cookie (identity-only, same shape as ops), `customer` role — **no capability overlap with ops RBAC**.
- Endpoints: `GET /board` (public, cached), `GET /board/:id`, `POST /board` (create), `POST /board/:id/join`, `POST /board/:id/scratch`, PayHere preapproval callback on `/webhooks`.
- Scheduler jobs: cutoff sweep (charge-or-expire + fallback-ladder emails), charge-failure retry/dunning, reminder nudges ("2 more names, 24h left — share again?").
- Analytics: every list + every member event into the founder Analytics funnel (Beeline lesson); share links carry a `ref` token from day one.
- Migration: new numbered Drizzle migration; **owner-run release step per CLAUDE.md rule 7** (staging-first).

### Payment specifics (verified against PayHere docs 2026-07-23)

[Preapproval API](https://support.payhere.lk/api-&-mobile-sdk/preapproval-api) tokenizes the card ($0), token arrives via server callback; [Charging API](https://support.payhere.lk/api-&-mobile-sdk/charging-api) charges any amount later (OAuth App ID/Secret). Constraints: **Visa/MasterCard only**; Automated Charging needs PayHere approval on the merchant account; charge-time failures are guaranteed (expired cards) → grace-period retry + "your seat is at risk" email + list-regression rule. This is the same machinery family as the deferred deposits/payments work — build them as one programme, not twice.

## 6. Open issues (from the 2026-07-23 self-critique — all pre-build)

1. **Cold start / empty states — the real day-1 problem.** Design the empty board and empty-corridor states ("be the one who starts Ella → Mirissa this week"), ops-seeded lists on 1–2 liquid corridors, "last Saturday this route ran with 5" proof. **No fake activity ever** (prototype's drifting names are demo-only).
2. **Duplicate-list dedupe nudge — the most important growth mechanic.** Create-flow step 1 must search near-matching open lists and interrupt: "Léa's list is one day earlier and needs 2 — join it instead?" Duplicates split demand that would have tipped one list (the Chariot failure mode).
3. **Honest PayHere handoff.** Real preapproval is a redirect/hosted page, not inline fields. Design the before/after framing; decide modal vs full-page step.
4. **Per-corridor threshold** from the rate card, not a hardcoded 4 (copy/dots/stamps must render N).
5. **Capacity mismatch:** prototype says "max 6 travellers"; backend `SHARED_CAPACITY` is 12. Ops decides per-van capacity; make it data.
6. **Slot vs fixed times:** prototype's Morning/Afternoon chips vs backend fixed corridor times — reconcile (likely: slot at creation, exact time set at confirm).
7. **Timezone:** deadlines shown in Asia/Colombo with explicit label; date rules already exist in `domain/dateRules.ts`.
8. **List regression:** scratch-off can drop a list back below threshold — design the notification + emotion ("a name dropped off; you're back to needing 2") and anti-gaming limits (e.g. re-join cooldown).
9. **Group signing:** "bring a friend = two lines" is promised in FAQ but the join flow has no seat count — add it (charged together or not at all).
10. **My-lists surface:** none in v1 beyond email links — make that an explicit decision; capability-token "manage my name" link in every email (reuse booking-token pattern).
11. **Mobile pass on the detail page:** right-rail join card → sticky bottom bar; untested in prototype.
12. **Accessibility:** clickable divs → buttons/links with focus states, modal focus trap, non-color status affordances.
13. **Privacy controls:** public first-name+flag on an indexable page — offer initials-only display; confirm GDPR posture for EU travellers.
14. **Visual warmth:** post-corkboard over-correction — reintroduce 1–2 restrained physical touches beyond the confirmed stamp.

## 7. Sequencing & dependencies

- **Hard dependency:** deposits/payments programme (PayHere preapproval/charging/refund machinery + merchant-account approval) — deferred until after go-live + a few weeks stable (owner 2026-07-23). The Ride Board build follows it; **do not start without a fresh explicit go.**
- Soft dependencies: WordPress→new-site cutover (board wants real traffic), customer Google auth (new subsystem, shared with any future account features).
- Suggested slices when greenlit: (1) read-only board + detail pages with ops-seeded lists + WhatsApp-enquiry join (wizard-of-oz money), (2) Google auth + free join/scratch + emails, (3) preapproval + charging + fallback ladder, (4) create-a-list + dedupe nudge + ref-tracked share links.

## 8. Decisions log

- Corridor-constrained dropdowns, never free-form places (owner, 2026-07-23).
- Card-on-file preapproval at join; charged only at threshold (owner: "you only get charged if min threshold").
- Viral loop via self-interested sharing + share-link landing pages; **no share-gating** signups (unverifiable + drop-off).
- Hostel-noticeboard voice, non-salesy, people-first ("find my people") — but rendered in the site's editorial design system, not literal corkboard (owner rejected skeuomorphism, 2026-07-23).
- Board = landing page; no separate explainer page (owner, 2026-07-23).
- Per-list detail page exists (trust + share destination); card ask comes last (owner raised trust concern; agreed).
- Predictable labels: navigation looks like navigation; "your name here?" is the single action shortcut and it genuinely starts the join (owner, 2026-07-23).
- Pricing display: flat corridor seat price with "$0 if it doesn't run" framing; no dynamic price-drop mechanic in v1 (simplicity; revisit if sharing needs a stronger incentive).
