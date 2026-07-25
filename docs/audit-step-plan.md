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

- [ ] **S8 — Homepage / search / planner.** Unqualified "Free cancellation", `alert()` boxes,
      money-format drift, search 6+ silently jumping to WhatsApp, planner has zero analytics.
      Files: `index.html`, `search.*`, `plan.*`.

- [ ] **S9 — Route pages (SEO, cutover-sensitive).** 8 reverse-direction pages describing the journey
      backwards, false duration precision ("about 2h 57m"), shared-seat intent missing from all 44
      titles, zero internal links. Files: `tools/route-content.json`, `tools/generate-route-pages.mjs`.

- [ ] **S10 — Brand/CSS hygiene.** ~14px nav logo, base64 logo inlined twice on 44 pages,
      `board.html`'s duplicated token set, sub-44px tap targets.

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
