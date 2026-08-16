# Customer route estimate UX contract

**Date:** 2026-08-16

**Status:** Proposed — awaiting owner approval

**Scope:** UI/UX consistency for customer-facing distance and journey-duration estimates

**Depends on:** The engine-driven customer pricing and distance-cache work owned by the separate implementation task

**Does not replace:** `2026-08-12-engine-driven-prices-design.md`

## 1. Decision summary

Ceylon Hop will treat route information as a **contextual estimate**, not as one immutable number that must be repeated after the journey locations become more precise.

- Browse surfaces use the reviewed town-to-town or corridor estimate.
- Booking uses the same estimate until exact pickup and destination locations are resolved.
- Once exact locations are resolved, booking may show an updated estimate returned by the authoritative server route service.
- A change is never applied silently. Material changes are announced and explained.
- Customer-facing distance and time use one shared rounding and wording policy.
- Live map rendering does not independently replace customer-facing route information.
- Static SEO route pages use a versioned export of the reviewed canonical route data.

Recommended customer copy:

> Approx. 335 km · around 5 hours

After a material exact-location update:

> Updated for your pickup and destination: approx. 340 km · around 5½ hours

When only an offline estimate is available:

> Estimated journey — final route confirmed before payment

## 2. Problem statement

Customers currently see slightly different distance and duration values for the same apparent route as they move between route landing pages, search, and booking. For example, Colombo Airport to Ella has appeared as approximately 334–335 km and 4 hours 56 minutes–5 hours depending on the surface.

The discrepancy occurs because different surfaces use different sources: a baked route table, a server-side Maps result, or a live browser map route. Even when the numerical difference is small, changing information weakens confidence in the fixed-price promise and makes the product feel less controlled.

At the same time, forcing one value everywhere would be misleading. A town-centre estimate can legitimately change once a customer provides an exact hotel, villa, airport terminal, or pickup point.

## 3. Goals

### User goals

1. Customers understand that distance and time are approximate without interpreting them as unreliable.
2. The same route estimate remains stable while the underlying route inputs remain unchanged.
3. Customers understand why an estimate changes after they provide more precise locations.
4. Customers never reach payment with an unexplained route or price change.
5. Route information remains understandable during API failures or estimated-distance fallbacks.

### Business and quality goals

1. Eliminate unexplained cross-screen route-estimate drift for identical route inputs.
2. Ensure every customer-facing surface uses the same formatter and estimate-state vocabulary.
3. Prevent generated route pages from drifting from the reviewed canonical route snapshot.
4. Preserve indexable static route pages without making them dependent on a live production API at request time.

## 4. Non-goals

1. **Pricing unification.** Price calculation and the distance cache remain owned by the separate engine-driven pricing task.
2. **Real-time arrival predictions.** This work does not promise traffic-aware ETAs or guaranteed arrival times.
3. **Route selection.** Fastest-versus-no-tolls route choice remains a separate product decision.
4. **Maps-provider migration.** This specification does not change Google Maps or its adapters.
5. **Operations tooling.** Internal precise distance and duration displays are not changed by this customer-facing formatting contract.
6. **A new permanent client-side distance engine.** The browser must not gain another independent formula or authoritative route table.

## 5. Terminology and route states

### 5.1 Browse estimate

The reviewed directional estimate between canonical places, used before exact addresses are known. Examples include Colombo Airport to Ella and Kandy to Galle.

### 5.2 Exact-location estimate

An updated server result calculated after the customer supplies resolved pickup and destination locations. It may legitimately differ from the browse estimate.

### 5.3 Estimated fallback

A server-generated approximation used when an authoritative routed distance is unavailable. It must be flagged as estimated and cannot be presented as a confirmed fixed route.

### 5.4 Unavailable state

No safe estimate is available. The UI displays no invented distance or duration and explains what happens next.

### 5.5 Estimate identity

Every estimate displayed during a journey must be traceable to the route inputs and estimate state that produced it. The implementation may use an estimate ID, route-data version, or equivalent immutable fingerprint. The specific mechanism belongs to engineering; the observable requirement is that unchanged inputs cannot silently produce a different displayed estimate within the same customer journey.

## 6. User stories

1. As a traveller comparing routes, I want a clear approximate distance and journey time so that I can judge whether a transfer fits my itinerary.
2. As a traveller moving from search into booking, I want the route information to remain stable so that I trust I selected the correct journey.
3. As a traveller providing an exact hotel or villa, I want to know when and why the estimate changes so that I do not think the site made an error.
4. As a traveller using an unusual or newly added location, I want the site to distinguish an estimate from a routed result so that I understand its confidence level.
5. As a traveller during a routing-service outage, I want a clear next step rather than a fabricated or stale value.
6. As a screen-reader user, I want material estimate updates to be announced without interrupting unrelated form completion.

## 7. Display contract

### 7.1 Customer-facing rounding

Distance:

- Below 20 km: round to the nearest 1 km.
- At or above 20 km: round to the nearest 5 km.
- Prefix with `Approx.` or use copy that makes approximation explicit.

Duration:

- Below 60 minutes: round to the nearest 5 minutes.
- From 60 minutes through 3 hours 59 minutes: round to the nearest 15 minutes.
- At or above 4 hours: round to the nearest 30 minutes.
- Use `around`, never an unqualified minute-precise duration.
- Half hours may be rendered as `1½ hours`, `4½ hours`, and so on where that improves scanning.

Examples:

| Raw route result | Customer display |
|---|---|
| 7 km, 18 min | Approx. 7 km · around 20 minutes |
| 118 km, 177 min | Approx. 120 km · around 3 hours |
| 335 km, 297 min | Approx. 335 km · around 5 hours |
| 338 km, 322 min | Approx. 340 km · around 5½ hours |

Internal operations screens may retain precise values.

### 7.2 Wording by state

**Browse or authoritative routed estimate**

> Approx. {distance} · around {duration}

**Exact-location estimate after a material update**

> Updated for your pickup and destination: approx. {distance} · around {duration}

**Estimated fallback**

> Estimated journey — final route confirmed before payment

If safe approximate figures are displayed, they remain visually subordinate to the estimated-state label.

**Unavailable**

> We’ll confirm the journey time after reviewing your locations.

Do not display zero, a dash without explanation, a straight-line distance, or a previous route's value.

### 7.3 Material-change threshold

An exact-location result is considered materially different when either:

- displayed distance changes by at least 5 km; or
- displayed duration changes by at least 15 minutes.

Changes below both thresholds may update without a prominent notice because the rounded customer display should normally remain unchanged.

Any price change follows the separate pricing-change confirmation rules, regardless of these distance and duration thresholds.

### 7.4 Accessibility

- A material update is announced through a polite live region.
- The announcement includes the reason and new values.
- Focus is not moved automatically.
- Colour is not the only indication that an estimate changed or is provisional.
- The update message remains visible long enough to be reviewed and is included in the booking summary.

## 8. Source and precedence rules

1. A server-returned authoritative estimate for the current resolved route inputs has highest priority.
2. Before exact locations exist, use the reviewed directional browse estimate.
3. A flagged estimated fallback may be shown only with the estimated-state treatment.
4. When no valid result exists, show the unavailable state.
5. A browser map may visualize the route but must not independently overwrite the displayed distance, duration, or price.
6. If map rendering requires a different route result from the one shown to the customer, engineering must resolve the source mismatch rather than hide it in presentation code.
7. Reverse directions are distinct routes. A to B must not automatically inherit B to A values.
8. Cached or fallback results must never be mistaken for a more authoritative state than their source supports.

## 9. Surface requirements

### P0 — must have

#### 9.1 Shared formatter

- One shared customer-facing formatter implements the distance, duration, state, and wording rules in this specification.
- Search, booking, planner route summaries, and generated route pages use the same tested formatting contract.
- No surface contains its own competing duration-rounding function after migration.

#### 9.2 Search

- Search displays the browse estimate associated with the selected direction and canonical places.
- The estimate passed into booking retains its identity or route-data version.
- Re-rendering the page does not change the displayed estimate while inputs remain unchanged.

#### 9.3 Booking

- Booking initially displays the estimate selected in search or returned for the same route inputs.
- Exact-location resolution requests a new authoritative estimate when supported by the upstream service.
- A material change is explained using the copy and accessibility behaviour in section 7.
- The live map cannot silently replace route information.
- The final summary reflects the latest accepted route estimate.

#### 9.4 Static route pages

- Route pages are generated from a versioned, reviewed route-data export.
- Route-page hero copy, FAQ copy, metadata, and structured data use the same exported values and formatting policy.
- Generated output remains committed and protected by the existing freshness test.
- A production database or Maps API is not called when a visitor requests a static route page.

#### 9.5 Failure and fallback states

- An estimated result is visibly labelled.
- An unavailable result contains explanatory copy and a next step.
- The UI never reuses a route estimate belonging to different inputs.
- A loading state does not flash an old value.

#### 9.6 Analytics and diagnostics

- Record the surface, route-input fingerprint, estimate state, and whether a material update occurred.
- Do not send raw customer addresses in analytics.
- Client error reporting distinguishes unavailable routing from a rendering failure.

### P1 — should have

- Show `Why did this change?` help text beside a material exact-location update.
- Add a route-data version and generation timestamp to internal diagnostics.
- Provide a CI comparison report when an exported canonical route changes materially.

### P2 — future considerations

- Departure-time-aware duration ranges.
- Traffic or weather confidence indicators.
- Customer selection between fastest and no-tolls routes.
- Explicit route-change history in the booking summary.

## 10. Acceptance criteria

### Stable browse journey

- Given a customer searches for Colombo Airport to Ella,
- when they proceed from search into booking without changing either location,
- then both surfaces display the same rounded distance and duration,
- and the estimate does not change when the map finishes loading.

### Exact-location update

- Given a customer begins with a canonical town-to-town estimate,
- when exact resolved locations produce a material route change,
- then booking displays the updated rounded values,
- explains that the change is based on the pickup and destination,
- announces the update through a polite live region,
- and includes the updated estimate in the final summary.

### Immaterial update

- Given an exact-location calculation changes the raw route by less than both material thresholds,
- when the result is applied,
- then the customer does not see a disruptive change notification,
- and the rounded display remains stable whenever the formatting rules produce the same value.

### Estimated fallback

- Given only an estimated fallback is available,
- when route information is displayed,
- then it is labelled `Estimated journey`,
- and it is not presented as a confirmed route or guaranteed journey time.

### Unavailable route

- Given no valid route estimate is available,
- when the route summary renders,
- then no fabricated number, stale result, or unexplained dash is shown,
- and the customer receives the unavailable-state explanation and next step.

### Generated route-page freshness

- Given the reviewed route-data export changes,
- when the freshness test runs without regenerated route pages,
- then the test fails.
- When the generator is run,
- then visible copy, metadata, FAQ structured data, and related-route summaries use the updated formatted values.

### Directionality

- Given A to B and B to A have different authoritative route results,
- when each direction is displayed,
- then each surface uses the correct directional estimate.

## 11. Test strategy

Every implementation step follows red-to-green development and the repository's one-step, one-branch, one-PR rule.

### Formatter unit tests

- Boundary tests at 19/20 km, 59/60 minutes, and 239/240 minutes.
- Half-hour and whole-hour wording.
- Browse, exact-update, estimated, and unavailable states.
- No false precision in customer-facing output.

### Search and booking tests

- The same route-input fingerprint produces the same display on both surfaces.
- Map completion cannot overwrite authoritative route text.
- Exact-location material changes display and announce the update.
- Immaterial changes do not create a disruptive notice.
- Loading, timeout, estimated, and unavailable states never reuse stale data.

### Generator tests

- Route pages consume the reviewed export.
- Directional routes remain distinct.
- HTML, metadata, FAQ JSON-LD, and related-route cards agree.
- The existing code-generation freshness test fails on drift.

### Full regression gate

- Run `npm run test:all` from `web-tests/` for each front-end step.
- Run the API gate required by the upstream distance/pricing step when that step changes backend behaviour.

## 12. Success metrics

### Release quality

- Zero automated mismatches between search and booking for identical estimate identity and inputs.
- Zero generated-route-page freshness drift in CI.
- Zero customer-facing minute-precise durations of one hour or longer.
- Zero silent material estimate changes in covered end-to-end journeys.

### Post-release monitoring

- Track the percentage of booking journeys receiving a material exact-location update.
- Track routing unavailable and estimated-fallback rates by surface.
- Review booking abandonment after a material route update against the prior step's baseline.
- Review route/duration-related support conversations after 30 days; target a reduction once a usable baseline exists.

## 13. Dependencies and delivery sequence

### Dependency gate

Do not migrate customer surfaces until the separate engine-driven pricing/distance task provides:

- an authoritative directional route result;
- a reliable estimate state;
- a safe exact-location update path where supported; and
- a reviewed, versionable route-data export for static generation.

### Delivery slices

1. **Presentation contract and formatter:** approve this specification; implement formatter tests and the shared formatter.
2. **Search and booking adoption:** migrate customer journey displays and exact-location update messaging.
3. **Planner adoption:** migrate route summaries without changing planner structure.
4. **Static route-page adoption:** change the generator input, regenerate pages, and verify SEO output.
5. **Cleanup:** remove superseded customer-facing duration formatters and presentation-only route fallbacks after every consumer has migrated.

Each slice is separately scoped, tested, reviewed, and delivered according to the repository build plan.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| This work duplicates the separate pricing migration | Treat the upstream route result and export as dependencies; do not create a second data engine here. |
| Exact-address updates feel like bait-and-switch | Explain the reason, show changes before payment, and use the separate price-change confirmation rules. |
| Rounding hides a meaningful route change | Use material thresholds on raw values and announce qualifying changes even when one rounded field remains the same. |
| Static route pages become stale | Version the export and retain the generator freshness gate. |
| API failure leaves blank or misleading UI | Implement explicit loading, estimated, and unavailable states with stale-result protection. |
| Route times are mistaken for guarantees | Use `around` consistently and avoid minute-level precision. |

## 15. Open questions

### Blocking owner approval

1. Approve the rounding policy in section 7.1.
2. Approve the material-change thresholds of 5 km or 15 minutes.
3. Approve `Approx.` and `around` as the standard customer vocabulary.

### Engineering confirmation before implementation

1. What immutable estimate identity or route-data version will the upstream service expose?
2. How will the reviewed distance-cache export be produced and versioned for static generation?
3. Can the authoritative server route service accept the same resolved exact locations used by the booking map without an out-of-scope interface change?
4. Which existing price-change confirmation component should own combined price and route updates?

## 16. Approval

Approval of this specification authorizes the customer-facing UX contract only. It does not authorize a new Maps integration, pricing change, database migration, or public API interface change. Those remain governed by their own approved build steps.
