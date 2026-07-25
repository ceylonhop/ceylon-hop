# Website audit — 2026-07-25

Full audit of the customer site (copy · design · marketing/SEO · booking UX) plus a security review of
payments, pricing and access control. Audited `origin/main` @ `7047afb` and the live GitHub Pages build.

**How to use this doc:** the [Owner decision queue](#owner-decision-queue) is the only part that needs *you*.
Everything else is either done (`[x]`) or actionable by an engineer without further input (`[ ]`).
Most of the audit is **still open** — the fix run was cut short by a session limit.

Status legend: `[x]` fixed in this batch · `[ ]` open, actionable · `[?]` blocked on an owner answer.

**Context that shapes priorities:** the apex `ceylonhop.com` still serves the old WordPress site. This repo is
the replacement, already public on GitHub Pages. Findings marked **CUTOVER** must be resolved before the
apex switch (M16) or they cost real rankings.

---

## Owner decision queue

These need a human answer. Each one blocks a specific fix.

| # | Question | Why it's blocked | What happens once answered |
|---|---|---|---|
| 1 | Are the three homepage testimonials (Maya, Tom & Elise, Priya) and the three driver profiles (Dinesh, Nuwan, Suresh — years driving, quotes) real people and real reviews? | Hardcoded strings sitting beside a genuine Tripadvisor badge. If any are composites it's a fake-review exposure. | Either source each from a real Tripadvisor review (and link it) or replace with real staff/reviews. |
| 2 | Is the Tripadvisor count still 30? And was "200+ real trips" on the Ride Board ever true? | The board claimed ~7× the number the rest of the site claims. | Align the board strings to the verifiable Tripadvisor figure (not yet done), and confirm 30 is current. |
| 3 | **What is the cancellation policy for shared seats / Ride Board rides?** | Terms §7 covers only transfers and chauffeur trips. The Ride Board explicitly defers to "normal cancellation terms" that do not exist. | Highest-value legal gap. A placeholder section is in place awaiting your rule. |
| 4 | Legal entity name + registration, governing law/jurisdiction, and the data controller's address. | The terms headline "the agreement between you and Ceylon Hop" but never identify the counterparty; the privacy policy needs a controller. | Fill the marked placeholders in `tools/legal/*.body.html`. |
| 5 | Does the Wed/Sat shared van pick up in **Colombo city**, or airport-only? | Four route pages sell a $19 shared seat on that corridor while one of them admits the seat departs from the airport. | Either qualify the four pages (and their JSON-LD) or state the pickup point. |
| 6 | Are shared seats **instantly confirmed**, or confirmed later on WhatsApp? | Search says "we confirm availability on WhatsApp"; booking charges immediately and promises "Instant confirmation". | Pick one story; if not instant, the pay step must state the refund path. |
| 7 | Extra bag: **$10** (hardcoded in booking copy) or **$5** (the rate card's `luggage` extra)? And is a car 2 or 3 bags? | Three surfaces disagree. | Single-source it and fix the copy. |
| 8 | Should the **child seat** add-on ($8, already in the rate card) be offered in the booking UI? And what's the policy for infants under 2? | Priced but never surfaced; families get no guidance. | Add the add-on + an infant line. |
| 9 | Is the **Ella train ticket paid for**, or only reserved? | "Reserved seats on the Ella train" sits in tour *includes* with no price clarity. | Disambiguate in `tours-data.js`. |
| 10 | **Southern Surf Coast** is sold as 7 days / 6 nights but the itinerary has only 6 days. What is the missing day? | Cannot be invented. | Add the day, or correct the duration. |
| 11 | Is "**Kaylab Hash B., Head of Marketing**" a real colleague? | Reads like a placeholder beside "Roshen W" / "Dasis K". | Keep, correct, or remove from `about.html`. |
| 12 | What backs "**Fully insured & safe drivers**"? | Asserted on the homepage, substantiated nowhere; the terms are silent on insurance. | Add one substantiating line + a terms clause. |
| 13 | Should the **Ride board stay in the public nav** pre-launch? | It's in the sitewide nav while the product is browse-only behind fakes. It is still crawlable and still in the nav; both need deciding. | Gate the nav entry or launch the product. |
| 14 | **Photography.** ~26 image slots have no image (tour cards, driver portraits, galleries, the footer band on every page). | Only the owner has real photos. Empty slots still render developer placeholder captions to visitors, which is the single most damaging cosmetic defect on the site. | Fill `image-slots.state.json`; separately, make empty slots render a branded panel instead of dev text. |
| 15 | Do you want the **primary teal button** darkened? | White-on-teal is 2.43:1 (WCAG needs 4.5:1). Fixing it changes the main brand button everywhere. | A darker teal (~`#067a77`) or ink-on-teal passes. |
| 16 | Are the **route pages** to be reskinned to the new brand? | All 44 still wear the pre-redesign flat-teal hero. They are the SEO landing pages, so a Google visitor meets the old brand first. | Sizeable design task; needs your direction. |
| 17 | "**Packaged tours**" → "Ready-made tours" retitle — confirm. | The old tab title contradicted the core "Not a packaged tour" positioning. Changed in this batch; flagging because it's positioning. | Keep or revert. |

---

## Fixed so far

A fix run was started on 2026-07-25 but was cut short by an API session limit part-way through, so
**most of the audit is still open**. Only the changes below actually landed. Everything else that the
audit found is listed further down — nothing has been silently dropped.

### Landed
- [x] **Literal `undefined` category pill** on the Southern Surf Coast tour — the `themeLabel` maps in
      `tours.html` and `tour.html` had no `coast` key. Added, plus a "Surf & coast" filter chip so the
      tour is reachable by anything other than "All tours".
- [x] **Tour teaser prices bypassed price-finishing.** Cards and the tour page showed raw computed
      values (`$357.45`, `$378.38`, `$188.8`) instead of the shipped nearest-50c policy. Both now run
      through `finishPrice`, and a shared `money()` helper stops `toLocaleString()` dropping trailing
      zeros. Card, tour page and checkout now agree: 349 / 369 / 229 / 329 / 189 / 289 / 279.
- [x] **Terms: the chauffeur cancellation ladder was self-contradictory** ("within 10 days" 80% and
      "within 7 days" 60% both applied at 5 days out). Rewritten as non-overlapping ranges with the
      same percentages and boundaries. Several template leftovers fixed in the same pass, and the
      genuine legal gaps marked with `OWNER TODO` comments in `tools/legal/terms.body.html`.
- [x] **Tour data contradictions:** the honeymoon tour excluded "all meals" while including a candlelit
      dinner; Wild Ceylon's "3 safaris arranged for you" hid that park/jeep fees are paid locally; day 1
      of the Classic Hop promised a "chauffeur-guide" that is actually a paid upgrade; the Tea & Trains
      final day labelled an Ella sunrise hike "Colombo"; the car-capacity comment said 4 guests, not 3.
- [x] **Tours page furniture:** "10+ Day tours" stamp (there are 7 tours, one of which is 10 days) →
      "7 Ready-made routes"; tab title "Packaged tours" → "Ready-made tours" (it contradicted the
      "Not a packaged tour" positioning — see Q17); breadcrumb "Full Tours" → "Tours"; en-dash and
      stray-comma nits.
- [x] **Booking calendar focus state** — groundwork for making calendar days keyboard-operable.

### Caught in review, do not re-introduce
- A fix agent changed the Southern Surf Coast `stops` from `'Airport'` to `'Colombo'`. Those are
  different places: `'Colombo'` resolves to Colombo **city**, silently repricing the tour and
  contradicting its own "Airport welcome" day 1. Corrected to `'Colombo Airport'`, which resolves to
  the same point as the original and leaves the price unchanged.

### Started but NOT finished (no code landed)
The booking-flow, homepage/search/planner, route-page-generator, brand/CSS/board, blog-port and
about/why batches were all interrupted before writing anything reviewable. Their scopes remain open
below, unchanged.

---

## Open — actionable without an owner answer

- [ ] **Per-tour static pages.** `tour.html` is `noindex` + client-rendered, so "Sri Lanka 7 day itinerary" queries have nothing to match. The route-page generator already proves the pattern. Largest remaining organic-traffic opportunity.
- [ ] **Structured data** on `why`, `about`, `tours`, `blog`, `plan`, `board` (currently zero JSON-LD); `BreadcrumbList` everywhere.
- [ ] **Analytics host-gating.** Only `purchase` is prod-gated; every other event fires from any host into the GTM container, so staging/preview pollutes GA4. Either gate them all or add a hostname exclusion in GA4/GTM (console-side).
- [ ] **Real 301s at cutover.** Legacy URLs are meta-refresh stubs. The generator comments say Cloudflare Bulk Redirects will front them — confirm that's configured before the switch. **CUTOVER**
- [ ] **Image SEO.** `image-slot.js` always renders `alt=""`, and photos ship as data-URIs in a 662 KB JSON sidecar loaded by every page that uses slots. Migrate filled slots to real `<img src alt>` — an accessibility, SEO and performance win at once.
- [ ] **Consolidate the design system.** ~2,000 lines of CSS live in per-page `<style>` blocks vs 510 in `site.css`, and components have already forked (`.tcard` means two different things; `.stepper` defined twice with different metrics). Promote shared components before the drift compounds.
- [ ] **Two icon systems.** 24px stroke SVGs in the chrome vs flat multi-colour clip-art PNGs on off-brand teal discs in the value props (at two different sizes). Pick one.
- [ ] **Checkout card logos** are hand-drawn CSS (Georgia-italic "VISA", a CSS-circle Mastercard). Use the official SVG marks.
- [ ] **Micro-typography floor.** Informational text runs down to 10.9px, and one label to 8.6px. Floor it at 12px.
- [ ] **Font loading.** Render-blocking `@import` with no `preconnect`; heavy axes requested.
- [ ] **Route-specific OG images.** One generic `og-cover.jpg` serves all 54 pages.
- [ ] **Competitive positioning gap.** `why.html` argues against buses, curbside taxis and package tours, but never PickMe/Uber (what tourists actually price-check) or 12Go (where they book).
- [ ] **Consent scope.** Accept grants `ad_storage`/`ad_user_data`/`ad_personalization` although no ad platform is wired; no granular toggle.
- [ ] **`author/k1ato`** leaks an old WordPress username in a public URL.

---

## Security review

See [`security-review-2026-07-25.md`](./security-review-2026-07-25.md) for findings, exploit paths and fixes
covering payment integrity (PayHere webhook/amount tampering), pricing and distance manipulation, and
access control.

---

## Verified clean — do not re-audit

- Price parity across all 44 route pages: chip ↔ Service JSON-LD ↔ FAQ ↔ meta description all agree, and the
  shared-seat figures match the backend corridor table. The PR #146 missing-`$` fix had no siblings.
- Route-page template hygiene: title, meta description, canonical, OG, single H1, visible + JSON-LD
  breadcrumbs, FAQ schema matching visible text — present on all 44.
- No fake urgency, countdowns or scarcity theatrics anywhere on the site.
- Consent defaults denied before GTM loads (Consent Mode v2); the banner remembers a rejection.
- `robots.txt` and the `noindex` strategy for search/booking/tour/manage are deliberate and correct.
- Payment-failure copy is genuinely excellent ("no charge was made", ad-blocker diagnosis, guilt-free
  cancellation) — do not churn it.
- `404.html` and `manage.html` error states are on-brand with human WhatsApp fallbacks.
- The chauffeur "idle day" understatement is a deliberate pricing-presentation decision, not a bug.
