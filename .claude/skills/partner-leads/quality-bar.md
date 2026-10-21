# Quality bar

A lead must pass **all five**. The critic records which item a rejected lead failed.

1. **Sells the destination:** a live page on the agency's own site that sells Sri Lanka (or the
   brief's stated equivalent). A blog post or FAQ mention is not enough.
2. **Not a competitor:** no ground operation of its own in Sri Lanka ("our team in Colombo",
   "own fleet in Sri Lanka", a Sri Lanka office), and not on the brief's exclusion list.
3. **Reachable by email:** an address the agency publishes as its own, on its own domain (a
   free-mail address only if the agency publishes it as its business contact). Phone- or
   WhatsApp-only agencies go under Reserves in the report, not in leads.csv. A pattern-inferred
   To is allowed only when a published company address also exists; put that published address
   in cc.
4. **Named decision-maker:** name + source + confidence (contact-rules.md). LOW is allowed;
   the greeting then uses the team name.
5. **Hook:** one true, specific detail, re-checked by the critic on `hook_source_url`, with the date in `verified_at`.

## Score (0–15)

Five factors, 0–3 each. Write the breakdown as `fit3 format3 hook2 reach2 cred2`.

| Factor | 3 | 2 | 1 | 0 |
|---|---|---|---|---|
| fit | sells our destination and the brief's pitch theme (e.g. Ramayana, elders) | sells the destination | nearby short-haul only | none |
| format | private/FIT | mixed | group/coach only | unknown |
| hook | a gap we fill, phrased as an offer | specific detail | generic detail | none |
| reach | named person's published address, or a B2B/partner inbox | company-domain inbox | company-published free-mail inbox | none |
| cred | 10+ years or strong third-party reviews | some tenure/reviews | self-claims only | nothing found |

Red flags cap cred at 1: presents legend as proven fact, copy-paste errors on the destination
page, internally inconsistent prices.

## Wave

- **Wave 1:** format `private` or `mixed`, and score ≥ 10.
- **Wave 2:** everything else that passed. Their email uses the brief's `Wave 2` pitch line (a
  private-car tier for families who ask, never a replacement for their coach).

## Price fit

Applies only when the brief's `## Price fit` section says `on` and gives a line
`Agency rate: <amount> per vehicle-day`; otherwise skip it. The critic reads the agency's own
published package price. If ground transport is clearly priced below our rate (e.g. a ₹28,999
6-day package for 6 people), the lead fails bar item 1 with reason `price-fit`.
