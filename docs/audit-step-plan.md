# Audit fix plan — step by step

Working agreement (owner, 2026-07-25): **one step at a time, check in after each.** This exists so
the work can be paused cleanly as the 5-hour credit window fills, and resumed by reading this file.

Each step is sized to land in one commit with tests green. Mark a step `DONE` with its commit when it
lands. Do not start a step without finishing the one before it.

Do not re-audit anything in the "DO NOT RE-AUDIT" registry at the top of
[`security-review-2026-07-25.md`](./security-review-2026-07-25.md).

---

## Done

- [x] **S1** Payment fail-open + `/quote/lock` rate limiting — `f1fa8d9`
- [x] **S2** Three demonstrated undercharge/oversell exploits ($125→$40, $789→$55, 84-seats-on-12,
      unbounded stops) — `ebf1e54`
- [x] **S3** Visitor-facing scaffolding: image-slot authoring text, board dev copy, board noindex,
      board review count — `457c22f`
- [x] **S4** Blog port: 6 real posts + the emoji URL — `85a41ba`
- [x] **S5** Ride Board CSRF — `fa7de9b`

## Next

- [x] **S6** Maps fallback now refuses to price instead of guessing — `ad3d728`. Also closes the
      second half of M1: an unpriceable booking is no longer chargeable at the $40 placeholder.
      Migration `0023` adds `bookings.needs_pricing` (nullable, additive).
      **Ops follow-up not yet built:** ops can see the flagged booking via the concierge task, but
      there is no UI to *set* a price on one and make it payable. Today that is a WhatsApp
      conversation. Worth a step of its own if outages are common.

<details><summary>S6 original scope (done)</summary>

- **Maps fallback: refuse to price, send to ops.** *(owner decided: refuse)*
      A Google failure silently falls back to crow-flies × 1.35, repricing Colombo→Ella
      $123.50 → $78.00 (−39%) with no flag, on any outage, quota exhaustion or key slip.
      Make an offline-estimated distance non-chargeable: persist the booking, block `/checkout`
      on it, raise a concierge task. Pairs with the unpriced-not-chargeable work in `ebf1e54`.
      Files: `api/src/adapters/maps.ts` (surface *how* the distance was resolved),
      `api/src/services/pricing.ts`, `api/src/routes/bookings.ts`.
      Risk: touches the money path — expect a conversion cost during a Maps outage, accepted.
</details>

- [x] **S7** Booking-flow UX — `97a00a9`. Shared "Decide later" dead end, terms link + real error,
      wallet chips, per-mode confirmation/perks, visible rate lock, `?id=custom` redirect, exits for
      over-capacity / off-service-day / out-of-radius, calendar keyboard access, "2 children".
      **Not done in S7 (deliberately, needs an owner answer):** the add-on/pay-chip and stepper aria
      work is partly done — steppers still lack labels; the child-seat add-on ($8, in the rate card)
      is still not offered; the bag-count and extra-bag-price disagreements across surfaces are Q7/Q8
      in the decision queue.

<details><summary>S7 original scope (done)</summary>

- **Booking-flow UX.** The shared-ride "Decide later" dead end (the one true dead end in the
      funnel), unlinked terms checkbox that fails silently, decorative Apple/Google Pay chips,
      "Your seat is booked!" on private transfers, the invisible 7-day rate lock, `?id=custom`
      charging $60/adult, and the calendar keyboard blocker (clickable `<div>`s).
      Files: `booking.html`, `booking.js`. Biggest customer-visible win left.
</details>

- [x] **S8** Homepage / search / planner — `a989f83`. Qualified "Free cancellation", title order,
      trust chip, `alert()` boxes → inline hints, dead modal removed, 404 dead end → in-place
      recovery, "6+" WhatsApp jump labelled, money format, planner analytics (was zero), UK spelling.
      **Left open:** the review count is still a literal in two places (cross-referenced by comment,
      not single-sourced — keeping it in the HTML keeps it crawlable); search still says shared
      availability is "confirmed on WhatsApp" while booking charges instantly (Q6).

<details><summary>S8 original scope (done)</summary>

- **Homepage / search / planner.** Unqualified "Free cancellation", `alert()` boxes,
      money-format drift, search 6+ silently jumping to WhatsApp, planner has zero analytics.
      Files: `index.html`, `search.*`, `plan.*`.
</details>

- [x] **S9** Route pages — `5ea976a`. Fixed the 8 reverse-direction pages, rounded the false
      duration precision, put shared-seat intent in the 31 corridor titles, added a derived
      "Related routes" block, and cleaned the wording (Ravana, shared ride, service days, corridor
      casing). All 44 regenerate from source; invariants re-verified across every page.
      **Left open:** the pages still wear the OLD flat-teal hero (Q16 — a design call), and the
      Colombo-city shared-seat pickup claim (Q5) is still unanswered.

- [x] **S10** Brand/CSS hygiene — `5e1880f`. Cropped the nav logo (glyph filled 42% of its
      canvas), replaced the twice-inlined base64 with a cached file (route pages 31.2KB → 15.3KB),
      de-duplicated board.html's token set (42 of 45 rules were copies of site.css), fixed sticker
      and WhatsApp contrast, regenerated the apple-touch-icon on brand teal, 44px datepicker hit
      areas, semantic state + motion tokens.
      **Left open:** the primary teal button is still 2.43:1 white-on-teal — Q15, an owner call
      since it changes the main CTA everywhere. `img/ceylon-hop-logo.jpg` and
      `img/ceylon-hop-icon.jpg` are now unreferenced but were left in place rather than deleted.

- [ ] **S11 — Remaining security, if wanted.** Injection, email-as-spam-relay, dependency hygiene,
      security headers, Ride Board charge path. None of these has been looked at.

## Needs an owner answer before it can be built

- **M4** `Idempotency-Key` is a global unauthenticated namespace — a victim reusing a key receives the
  attacker's booking including their contact details. Fix is to scope it to customer/session.
- **M3** chauffeur `days` is client-declared ($789 vs $329 for one itinerary); enforcing per-leg dates
  would restrict the flexible-dates behaviour the planner deliberately allows.
- The 17 product/content questions in [`site-audit-2026-07-25.md`](./site-audit-2026-07-25.md) —
  above all the shared-seat cancellation policy, which does not exist in any document.

## Guardrails

Linear, no agent fan-out. Review every edit before committing. Agents never run git. Regenerate
centrally (`npm run generate`) — `seo-codegen.test.js` catches drift. Prove a regression test fails
before the fix. Nothing is pushed or promoted; `main` auto-deploys to staging only.

Verify each step: `cd api && npx vitest run` (1047 passing) and `cd web-tests && npx vitest run`
(340 passing).
