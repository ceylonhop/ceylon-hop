# Launch Phase 0 — beta close-out checklist

State as of 2026-09-23. Phase 0 = close the gaps that would waste a launch push. The
post-trip review-request email is **deliberately not built** (owner: ask only travellers
who had a good experience, by hand, for now).

| item | status | who |
|---|---|---|
| Old WordPress URLs 301 to the new pages | **DONE** (Cloudflare bulk redirects enabled 2026-09-23; `/routes/`, `/trip/island_loop_6_stops/`, old shared-ride slugs all verified 301) | — |
| Search Console: sitemap + indexing requested | **DONE** 2026-09-23 | — |
| Board share links unfurl on a branded domain | **BLOCKED on dashboards** — steps below; PR #718 is green and updated with main, held as draft until the domain answers | owner |
| Meta pixel in GTM (retargeting audience before launch) | **HALF DONE** — the base pixel (`PageView`) is in the published container, so the audience is already building. The three conversion tags from PR #676 (`docs/analytics/gtm-meta-conversions.json`: Purchase / InitiateCheckout / Lead) are **not published**: the live `gtm.js` was fetched 2026-09-23 and contains `fbq('track','PageView')` only. Import + publish per `gtm-container-checklist.md` § "Meta pixel conversions" | owner (or a live session) |
| Google profile photos | **WAITING** — 0 photos uploaded by us; `img/about-gal-*.jpg`, `img/team-*.jpg` and the tour photos are candidates, or better: real vehicle + driver photos | owner |
| Stale third-party prices (Viator = "Over The Planet" booking buttons on Google/Tripadvisor) | **WAITING** — fix prices in the Viator supplier portal (owner sign-in) | owner |
| Launch code | **DECISION NEEDED** — promo backend is on staging only (migration 0050, flag off); the website field is unbuilt. Options: (a) promote + build the field (a migration reaches prod), (b) launch with a plain time-boxed offer and a manual discount in ops, no code | owner |
| Soft-launch email to past customers | **DRAFTED** — `soft-launch-email.md`; needs the WordPress sales export for pre-cutover customers and an opt-in filter | owner sends |
| Review replies, batches 2–4 | scheduled ~Sep 30 / Oct 6 / Oct 12 (texts in memory, owner-approved) | live session |

## ride.ceylonhop.com — exact steps (order matters)

`pay.`, `quote.` and `ops.` are each a DNS-only CNAME to `ceylon-hop-api.onrender.com`;
`ride.` is a fourth identical one. Set the domain up **before** the env var, or `og:url` on
links already circulating as `ops.ceylonhop.com/r/CODE` repoints to a host that doesn't
answer yet.

1. **Cloudflare DNS** (zone ceylonhop.com): add `CNAME ride → ceylon-hop-api.onrender.com`,
   proxy **off** (grey cloud), TTL auto.
2. **Render → ceylon-hop-api → Settings → Custom Domains**: add `ride.ceylonhop.com`. Wait
   for "Verified" and the certificate (a few minutes).
   Check: `curl -sI https://ride.ceylonhop.com/health` → 200.
3. **Render → ceylon-hop-api → Environment**: `SHARE_BASE_URL=https://ride.ceylonhop.com`.
   This restarts prod (single consumer: the share card's `og:url` / `canonical` /
   `og:image`; emails and PayHere are untouched).
   Check: `curl -s https://ride.ceylonhop.com/r/<any live code> | grep og:url` names
   `ride.ceylonhop.com`.
4. Mark PR #718 ready, merge to `main`, then promote `main → production` so board.html's
   Copy link and WhatsApp hand-off produce `ride.ceylonhop.com/<CODE>`.
5. Paste one link into WhatsApp and Facebook's Sharing Debugger; both should show the
   ride's own card.

Do **not** put `ride.` behind the Cloudflare proxy: the API sets cookies for sign-in on the
same registrable domain, and the other three aliases are grey-cloud for the same reason.
