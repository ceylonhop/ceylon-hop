# The Ride Board — community demand-pooling for shared rides

**Status:** design finalised via interactive prototype; **build greenlit by owner 2026-07-24** ("build this into the website fully functional; use shared-taxi backend infra where possible"). Execution is staged (see §7) and gated: schema migration is owner-run, and real Google-auth + PayHere preapproval/charging are wired behind adapters/fakes with the real swaps as separate owner-gated steps (per CLAUDE.md rules 4 & 7). Build order lives in `docs/build-plan-ride-board.md`.
**Date:** 2026-07-23 · **Updated:** 2026-07-24 (prototype reframe + build greenlight)
**Prototype:** [`docs/prototypes/ride-board-prototype.html`](../../prototypes/ride-board-prototype.html) — fully interactive static prototype (no API), open directly in a browser. This spec now matches the prototype as built.

> **2026-07-24 reframe (the important change).** Multi-angle critique found the mechanic fought traveller psychology: it reassured *money* anxiety ($0) while the real fear is *"will I have a ride?"*, and it competed with our own certain private-transfer product. The prototype was rebuilt to **lead with a guarantee, not a gamble**, positioned against the bus (net-new demand, not cannibalising private), with the operator doing the match-making. See §2 (Guarantee), §2 (Positioning), and the updated §6.

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
- **Threshold:** list "runs" at `minSeats` names. **Per-corridor, sourced from the rate card / departureRepo** (RESOLVED: 4×$14 and 4×$24 are different van economics; the number is data, and all copy/dots/stamps render `N`). Prototype default 4.
- **Capacity:** the van holds `CAP` seats (prototype 6). **Per-corridor data**, not a constant (RESOLVED: was a 6-vs-12 mismatch with `SHARED_CAPACITY`).
- **Deadline:** list closes at `cutoffAt` (default 48h before departure, Asia/Colombo, shown as a live countdown in the viewer's local time).
- **Departure time — window, converge at lock (RESOLVED):** a list gathers on a coarse **slot** (e.g. "morning, departs 7–9am") so a single fixed time doesn't shrink the pool. Each joiner marks a **preferred time** when they join; the group's most popular wins and the exact departure is **pinned when the van locks**, then emailed to everyone.
- **Lifecycle:** `gathering → confirmed | expired`. Confirmed lists keep accepting names up to `CAP`.
- **Money:** joining = card **preapproval hold, $0 charged** (PayHere Preapproval API). At threshold+cutoff, everyone is charged their seat price via the PayHere Charging API. List didn't fill → nobody pays.
- **Scratch-off:** free self-removal anytime before cutoff (releases the hold), surfaced as a real control on the ride page when you're on a list.
- **Identity:** customer Google sign-in (first customer-facing auth). Public display is **first name + country flag + Google profile photo** only — never email/phone (initials fallback when no photo / opted out).

### The Guarantee — lead with it (the 2026-07-24 reframe)

**"You travel either way."** This is now the headline promise on the hero, the ride page, and the join step — because it answers the traveller's real anxiety (*will I actually have a ride?*), which the $0 framing alone did not. The **fallback ladder is no longer a footnote**: at cutoff an unfilled list's members are moved to **(a) a private car at the fare split among current members**, or **(b) the next scheduled shared departure**, at the split price — or **(c) walk away, hold released**. So the value prop is *"add your name; if four come you split it cheap, if not we still get you there at the split price, and you're never charged for a ride that doesn't run."* Certainty, not a gamble.

### Positioning — against the bus, never our own private transfer

Framed as **"Share a ride. Beat the bus."** Every card and join panel shows a **shared / private / bus** comparison (e.g. "≈$24 shared seat · $78 private car · 7h bus"). The intent (RESOLVED business steering): pull **net-new price-sensitive travellers up from the bus/train**, not cannibalise the certain private-transfer product. Copy anchors on the bus's pain (time), not on undercutting our own margin.

### Match-making — the operator gathers, the traveller doesn't recruit alone

Thin lists carry a **"Ceylon Hop is gathering this one"** signal, and the board seeds a handful of lists on the liquid corridors/dates itself, so the experience is "add your name, we're already growing this" rather than "recruit three strangers yourself." The viral share loop is additive, not load-bearing. (No fake activity — see §6.1.)

### Copy voice (load-bearing)

Helpful hostel-noticeboard, never salesy: "add your name to the list", "4 names = we send a van", "you travel either way", "your name here?", "scratch off anytime". Seat scarcity language: **"N seats to lock it in"** before it runs, **"N seats left"** after it locks. Price framed socially ("≈ $24 each when it runs · $0 if not"), no strikethrough anchor pricing on the board.

## 3. UX / information architecture

Three surfaces, one page + one detail + one modal flow. **The board IS the landing page** — no explainer standing between the visitor and the wall of people.

### 3.1 Board (landing)

- **Header:** "Share a ride. *Beat the bus.*" + one-line explanation + the **guarantee box** ("You travel either way…") + Tripadvisor 5.0 badge + the red hand-note "$0 to add your name".
- **Filters — by traveller mental model, not corridor jargon (RESOLVED):** a **"Leaving from" city** dropdown + a **"When"** date window (Any time / This week / Next 2 weeks) + a **"My rides · N"** toggle (appears once signed-in-and-joined) + Clear. A live "N gathering now" count.
- **List card** (site ticket style, perforation divider): route in Newsreader serif; meta = date · slot · departure window + a **live "closes in Xh Ym" countdown** (turns tomato under 3h); seat-scarcity pill ("2 seats to lock it in" / "1 seat to lock it in — almost there" / "Locked in 🚐 · N seats left"); 4 progress dots; then **exactly 4 numbered sign-up lines** — **Google profile photos** + first names + flags, "started this list" on line 1, next open line rendered as dashed *"your name here?"*. Riders past 4 collapse to a "+N also riding" stacked-avatar row (equal card heights; grid uses stretch). Footer: price + a **shared/private/bus comparison** line + **"See ride & join →"**. Starter's note quoted at the bottom.
- **Felt urgency / states:** hot lists (one seat from running) **glow tomato**; lists you're on **glow teal** with a "You're on this ✓" tag and a "View your ride" CTA; thin lists show the **"Ceylon Hop is gathering this one"** chip; confirmed cards wear the postage stamp "IT'S ON! van locked".
- **Empty states (RESOLVED):** filtered-to-nothing and no-lists-yet render a real empty card ("Be the first to start this one — we'll help gather names, and you travel either way"), never a fake-full board.
- **Predictability rule (owner-set):** labels must match destinations. Card body & "See ride & join →" navigate to the ride page. The *"your name here?"* line is the one action shortcut: it opens the ride page **with the join flow auto-opened on top** — the label's promise is kept in one click, trust page visible behind.
- Last card: dashed **"Your ride's not up here?"** → create flow.
- **My rides surface (RESOLVED):** signed-in travellers get a "My rides · N" nav entry + board filter to the lists they're on (beyond the email capability-links).

### 3.2 Ride detail page (the trust builder AND the share-link destination)

Every list has a real page (`/board/<id>`; prototype uses `#/<id>`), because a WhatsApp/Facebook share must land somewhere link-able with OG tags ("Ella → Mirissa · Sat · 2 of 4 in · $24/seat"). Content order:

1. Route + meta (date · slot · **live countdown** · van · capacity) + scarcity pill + **Tripadvisor 5.0 badge**.
2. **Guarantee banner** — "You travel either way…" (the fallback ladder, first-class, right under the title).
3. **Who's in so far** — large **Google profile photos**/names/countries + dashed "you?" / "a friend?" join slots; starter's note.
4. **When it leaves** — the candidate departure times for the slot + "exact time set when the van locks; the group's most popular wins" (or the locked time once confirmed).
5. **Pickup & drop-off** — **predefined per-city points** (sourced from the live shared-taxi routes; e.g. "Ella — main street, by the station"), with the ~10 km door-to-door upgrade (reuses exact-spot radius rule).
6. **How the money works** — 3-step timeline reinforcing the guarantee: *Now $0 hold → at lock, 4 names = everyone charged (else you're moved to private/next-shared at the split price, never charged for a no-run) → departure day, driver name & WhatsApp the evening before.*
7. **Who's driving** — real operator, Tripadvisor 5.0, humans on WhatsApp, Google-verified travellers.
8. Mini-FAQ (cancel/scratch-off, pickup logistics, luggage).
9. **Sticky join card** (right rail): a big **$0** hero ("only charged ≈$X if the van locks in"), scarcity pill, avatar row, dots, a **shared/private/bus comparison strip**, live countdown, share buttons. **State-aware:** when you're already on the list it flips to "You're on this list" + "Invite someone — fill it faster" + **"Scratch my name off"**. Mobile: full-width below the content (sticky-bottom-bar is a follow-up).

### 3.3 Join flow (modal over the detail page, 3 steps)

1. **Google sign-in** — "lists only take real names"; privacy whisper: others see "Roshen 🇱🇰", nothing more.
2. **The deal + preferred time + card** — "$0 today" info box restating the **guarantee** ("if it doesn't fill we move you to a private car or the next shared ride at the split price — you travel either way"); a **"Your preferred departure time?"** chip row (RESOLVED — closes the promise the ride page makes; 07:00/08:00/09:00/Flexible); PayHere preapproval (real handoff is a redirect/hosted step — see §6.3), Visa/MC note.
3. **Success** — the member's name handwrites onto their line (Caveat), headline states the new count, then the **share moment**: a **live OG-style preview card** (LIVE badge, rider faces, "always shows the current count even after it locks") + WhatsApp / Facebook / copy-link. "We'll email you the second someone signs under you."

**Group signing** (RESOLVED as decision, still to build): "bring a friend" = a seat count in the join step; charged together or not at all.

### 3.4 Create flow (4 steps; same staircase + a plan step)

1. **Plan the ride** — From/To **dropdowns constrained to corridor stops** (no free-form autocomplete; anti-fragmentation by construction), any-date picker, Morning/Afternoon chips, optional note, quiet price strip, plus the **dedupe nudge (RESOLVED — the most important growth mechanic):** if an open list already exists for this exact hop, the step interrupts with "Léa's list already goes Ella → Mirissa — 2 more to run. Join it instead of starting a new one?" and a one-tap "Join Léa's list →". CTA otherwise: "Put it on the board" ("it goes up instantly — you're name #1 of 4").
2–3. Same Google + preferred-time + $0-hold steps.
4. **"Your list is up on the board."** — name on line 1, share moment is the payoff (the starter is the recruiter), plus "See your list on the board" → their ride page. New list appears at the front of the board immediately.

### 3.5 Living-board signals

**No fake liveliness** — the prototype's drifting names/toast theatre was cut. Real signals only: the "N gathering now" count, "My rides", email on every name-under-you and on confirm/expire, and the live OG share card.

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

## 6. Open issues

### 6.1 Resolved in the prototype (2026-07-24)
- **Cold start / empty states** — real empty-board + filtered-to-nothing states; operator seeds thin lists ("Ceylon Hop is gathering this one"). **No fake activity** (drifting-names theatre cut).
- **Duplicate-list dedupe nudge** — built into create step 1 (join the existing list vs fragment demand).
- **Per-corridor threshold** — `minSeats` is now data (rate card / departureRepo), all copy renders `N`.
- **Capacity** — `CAP` is per-corridor data (resolves the 6-vs-12 mismatch).
- **Slot vs fixed times** — gather on a slot, capture each joiner's preferred time, pin exact time at lock.
- **List regression framing** — scratch-off is a real control; the guarantee softens the "someone left" case (you still travel).
- **Group signing** — decided (seat count in join step, charged together or not at all); to build.
- **My-rides surface** — built (nav entry + board filter).
- **Value-prop / psychology** — reframed to lead with the guarantee, positioned against the bus, operator-matched (the core 2026-07-24 change).

### 6.2 Still open — carry into the build
- **List regression mechanics** — the notification when a name drops the list back below threshold, and anti-gaming limits (re-join cooldown). Framing done; behaviour to build.
- **Accessibility** — clickable divs → buttons/links with focus states, modal focus trap, non-colour status affordances (the prototype is desktop-first and not a11y-complete).
- **Privacy controls** — public first-name + flag + **Google photo** on an indexable page is a real step up; ship an **initials-only / hide-my-photo** option at sign-in and confirm GDPR posture for EU travellers. (Prototype has an initials fallback but no user control.)
- **Mobile** — detail-page join card is full-width, not yet a sticky bottom bar; needs a real mobile pass.
- **Visual warmth** — reintroduce 1–2 restrained physical touches beyond the confirmed stamp.
- **Share-card OG freshness** — WhatsApp/FB cache previews hard; needs server-rendered per-list OG tags + a dynamic OG image, and the landing page must always show live state even when the cached preview lags.

### 6.3 Honest PayHere handoff (build constraint)
Real preapproval is a **redirect / hosted page**, not the prototype's inline card fields. The join flow must hand off to PayHere (with clear before/after framing) and resume on the server callback. Wire behind the PayHere **adapter + fake**; the real merchant-approved swap (Automated Charging needs PayHere approval; Visa/MC only) is a separate **owner-gated** step. Charge-time failures are guaranteed (expired cards) → grace-period retry + "your seat is at risk" email + the list-regression rule.

### 6.4 Timezone
Deadlines computed in Asia/Colombo, shown as a live countdown in the viewer's local time; reuse `domain/dateRules.ts`.

## 7. Sequencing & dependencies

**Greenlit by owner 2026-07-24.** Execution follows `docs/build-plan-ride-board.md` — tiny tested steps (red→green), one step = one branch = one PR, `npm run check` + `npm run test:all` green before each PR. **Reuses shared-taxi infra** (corridor catalogue, atomic seat holds, DI/adapters/fakes, HMAC token links, notifications + scheduler) — see the build plan for the exact reuse map.

**Gated (owner-run / real-swap, per CLAUDE.md rules 4 & 7):**
- The Drizzle **migration is owner-run** (migrations are NOT auto-applied; a prior auto-apply caused a prod incident). Author the migration file in the step; owner applies it as a labelled release step, staging-first.
- **Real Google customer-auth** (OAuth client + secret) and **real PayHere preapproval/charging** (merchant Automated-Charging approval, App ID/Secret) are wired behind adapters/fakes; the real credential swaps are **separate owner-gated steps** and are **not shipped to prod** in the build.
- Nothing ships to prod without the owner's explicit ok.

**Build slices (each = its own PR set):**
1. **Backend foundation (fakes, no external services):** `rideList` Zod domain + rules (reuse corridor/date rules), repo interface + InMemory impl, migration file + `schema.ts` entries + Postgres impl, DI wiring in `app.ts`, read endpoints (`GET /board`, `GET /board/:id`) — all Vitest red→green.
2. **Customer auth + join/scratch (fakes):** customer GIS→HMAC session (reuse `opsAuth` shape, separate `customer` identity, faked verifier in tests), `POST /board/:id/join` (preapproval via PayHere adapter fake → member `held`), `POST /board/:id/scratch`, dedupe check, preferred-time capture, capability-token manage link.
3. **Create-a-list + lock/expire + emails:** `POST /board`, the cutoff sweep in `scheduler.ts` (charge-or-expire + fallback-ladder), `notifications.ts` senders (name-under-you, confirmed, expired-with-options), reuse `notification_log` dedupe.
4. **Front-end:** new root `board.html` + `board.js` following site conventions (reuse `transfers-data.js` corridor helpers, `window.CEYLON_HOP_API`), the ride detail page, join/create flows — ported from the prototype, covered by `web-tests/`.
5. **Real-swap steps (owner-gated):** real Google OAuth; real PayHere preapproval/charging; ref-tracked share links + Analytics events; server-rendered OG tags.

- Soft dependency: WordPress→new-site cutover (board wants real traffic).

## 8. Decisions log

- Corridor-constrained dropdowns, never free-form places (owner, 2026-07-23).
- Card-on-file preapproval at join; charged only at threshold (owner: "you only get charged if min threshold").
- Viral loop via self-interested sharing + share-link landing pages; **no share-gating** signups (unverifiable + drop-off).
- Hostel-noticeboard voice, non-salesy, people-first ("find my people") — but rendered in the site's editorial design system, not literal corkboard (owner rejected skeuomorphism, 2026-07-23).
- Board = landing page; no separate explainer page (owner, 2026-07-23).
- Per-list detail page exists (trust + share destination); card ask comes last (owner raised trust concern; agreed).
- Predictable labels: navigation looks like navigation; "your name here?" is the single action shortcut and it genuinely starts the join (owner, 2026-07-23).
- Pricing display: flat corridor seat price with "$0 if it doesn't run" framing; no dynamic price-drop mechanic in v1 (simplicity; revisit if sharing needs a stronger incentive).

### Added 2026-07-24 (prototype reframe + build greenlight)
- **Lead with the guarantee, not the gamble** — "you travel either way" (fallback ladder) is the headline promise everywhere; $0 is secondary. Answers the certainty anxiety, which is the traveller's real fear (owner-aligned via critique).
- **Position against the bus/train, never our own private transfer** — "Share a ride. Beat the bus." + shared/private/bus comparison. Pull net-new demand, don't cannibalise private margin.
- **Operator match-making is primary, viral sharing additive** — seed thin lists, "Ceylon Hop is gathering this one"; don't rely on travellers to recruit strangers.
- **Departure = slot + preferred-time, pinned at lock** (window fills the van; converge once).
- **Threshold and capacity are per-corridor data**, not constants; all copy renders N.
- **Filter by from-city + date window**, not corridor labels; **My rides** surface added.
- **Scratch-off is a real control**; **dedupe nudge** built into create.
- **Real Google profile photos** (initials fallback); **predefined per-city pickup points** from the live shared-taxi routes; **Tripadvisor 5.0** trust badge surfaced early.
- **No fake activity** — drifting-names/toast theatre cut.
- **Build greenlit 2026-07-24**; schema migration owner-run; real Google-auth + PayHere preapproval behind fakes with owner-gated real swaps; **reuse shared-taxi backend infra** where possible.
